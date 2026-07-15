/**
 * Page-level content classifier for ingest.
 * Deterministic detection first; LLM (Gemini preferred, OpenAI fallback) for ambiguous
 * pages and attribute / search_terms enrichment. Runs once per page before chunking.
 */

const crypto = require("crypto");
const axios = require("axios");
const { OpenAI } = require("openai");
const {
  detectContentType,
  normalizeEntityType,
  normalizeSourceType,
  inferSourceTypeFromMetadata,
  calibrateClassificationConfidence,
  ENTITY_TYPES,
} = require("../utils/contentTypeDetection");
const {
  extractSearchTerms,
  extractPayloadAttributes,
} = require("../utils/searchTerms");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");
const {
  logOpenAIUsage,
  computeTokenCosts,
} = require("./UsageTrackingService");

const MAX_LLM_CHARS = 6000;
const HIGH_CONFIDENCE_SKIP = 0.9;

function isClassifierEnabled() {
  const flag = String(process.env.CONTENT_CLASSIFIER_ENABLED || "")
    .trim()
    .toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return false;
  if (flag === "true" || flag === "1" || flag === "on") return true;
  // Default: enabled when any classifier key is present
  return Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.OPENAI_API_KEY,
  );
}

function contentHash(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
}

function extractHeadingPath(chunkText = "") {
  const headings = [];
  for (const line of String(chunkText).split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)\s*$/);
    if (m) headings.push(m[1].trim());
    if (headings.length >= 3) break;
  }
  return headings.length ? headings.join(" > ") : "";
}

function heuristicAttributes({ text, title, url }) {
  const attrs = {};
  const combined = `${title || ""}\n${text || ""}`;

  const priceMatch = combined.match(
    /(?:\$|€|£|₹)\s?([\d,]+(?:\.\d{2})?)|\b([\d,]+(?:\.\d{2})?)\s*(?:usd|eur|gbp|inr)\b/i,
  );
  if (priceMatch) {
    const raw = (priceMatch[1] || priceMatch[2] || "").replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isNaN(n)) attrs.price = n;
  }

  const payloadAttrs = extractPayloadAttributes({ text, title, url });
  if (payloadAttrs.sizes?.length) attrs.sizes = payloadAttrs.sizes;
  if (payloadAttrs.collections?.length) {
    attrs.collections = payloadAttrs.collections;
  }

  const bedroom = combined.match(/\b(\d+)\s*(?:bed(?:room)?s?)\b/i);
  if (bedroom) attrs.bedrooms = Number(bedroom[1]);

  const salary = combined.match(
    /\b(?:salary|compensation|pay)\b[:\s-]+([^\n.]{3,60})/i,
  );
  if (salary) attrs.salary_range = salary[1].trim();

  return attrs;
}

function mergeAttributes(...bags) {
  const out = {};
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const [k, v] of Object.entries(bag)) {
      if (k.startsWith("_")) continue;
      if (v == null || v === "") continue;
      if (Array.isArray(v)) {
        const prev = Array.isArray(out[k]) ? out[k] : [];
        out[k] = [...new Set([...prev, ...v.map(String)])];
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function mergeSearchTerms(...lists) {
  const set = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const s = String(t || "")
        .trim()
        .toLowerCase();
      if (s.length > 1) set.add(s);
    }
  }
  return Array.from(set).slice(0, 80);
}

function projectFilterableAttrs(attributes = {}) {
  const sizes = Array.isArray(attributes.sizes)
    ? attributes.sizes.map((s) =>
        String(s).replace(/\s/g, "").toLowerCase(),
      )
    : [];
  const collections = Array.isArray(attributes.collections)
    ? attributes.collections.map(String)
    : [];
  return {
    sizes: [...new Set(sizes)],
    collections: [...new Set(collections)],
  };
}

function buildClassifierPrompt({
  url,
  title,
  metaDescription,
  text,
  websiteLanguage,
  detection,
}) {
  const snippet = String(text || "").slice(0, MAX_LLM_CHARS);
  return `You classify a single website page for a RAG knowledge base.

Return JSON only with this shape:
{
  "entity_type": "product|listing|faq|job_posting|service|blog_post|policy|docs|about|general",
  "entity_name": "string or null",
  "search_terms": ["synonyms and alternate user phrasings, max 20"],
  "attributes": { "price": number?, "sizes": string[]?, "collections": string[]?, "...vertical keys" },
  "classification_confidence": 0.0,
  "classification_reason": "short justification",
  "language": "ISO 639-1 code"
}

Rules:
- Prefer the deterministic hint when strong: entity_type=${detection.entity_type}, signal=${detection.signal}, reason=${detection.reason}
- Confidence must reflect signal strength (schema ~0.9+, clear URL/DOM ~0.6-0.8, ambiguous ~0.3-0.5)
- search_terms improve recall: synonyms a visitor might type (not stopwords)
- attributes only when present on the page; do not invent prices
- Allowed entity_type values only: ${ENTITY_TYPES.join(", ")}

Website language hint: ${websiteLanguage || "en"}
URL: ${url || "(none)"}
Title: ${title || "(none)"}
Meta description: ${metaDescription || "(none)"}

Page content:
${snippet}`;
}

function parseClassifierJson(raw) {
  let text = String(raw || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callGemini({ model, prompt, apiKey, timeoutMs }) {
  const modelName = model || process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await axios.post(
    url,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    },
    { timeout: timeoutMs || 30000 },
  );
  const text =
    res.data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("") || "";
  const usageMeta = res.data?.usageMetadata;
  const usage = usageMeta
    ? {
        prompt_tokens: usageMeta.promptTokenCount || 0,
        completion_tokens: usageMeta.candidatesTokenCount || 0,
        total_tokens: usageMeta.totalTokenCount || 0,
      }
    : null;
  return { text, usage, modelName };
}

async function callOpenAI({ model, prompt, apiKey, timeoutMs }) {
  const client = new OpenAI({
    apiKey: apiKey || process.env.OPENAI_API_KEY,
    timeout: timeoutMs || 30000,
  });
  const modelName = model || "gpt-4.1-nano";
  const response = await client.chat.completions.create({
    model: modelName,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You classify web pages for RAG. Return JSON only.",
      },
      { role: "user", content: prompt },
    ],
  });
  return {
    text: response.choices?.[0]?.message?.content || "",
    usage: response.usage || null,
    modelName,
  };
}

async function resolveClassifierRuntime() {
  let cfg = null;
  try {
    cfg = await getResolvedModelConfig("content-classifier", [
      "micro-classifier",
      "intent",
    ]);
  } catch {
    cfg = null;
  }

  const envProvider = String(
    process.env.CONTENT_CLASSIFIER_PROVIDER || "",
  ).toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  let provider = envProvider || cfg?.provider || "";
  if (!provider || provider === "google") {
    provider = geminiKey ? "gemini" : "openai";
  }
  if ((provider === "gemini" || provider === "google") && !geminiKey) {
    provider = "openai";
  }

  return {
    provider,
    model:
      process.env.CONTENT_CLASSIFIER_MODEL ||
      (provider === "gemini"
        ? process.env.GEMINI_MODEL || "gemini-2.0-flash"
        : cfg?.model || "gpt-4.1-nano"),
    apiKey:
      provider === "gemini"
        ? geminiKey
        : cfg?.apiKey || process.env.OPENAI_API_KEY,
    timeoutMs: cfg?.timeoutMs || 30000,
    cfg,
  };
}

async function runLlmClassify(page, detection, options = {}) {
  const runtime = await resolveClassifierRuntime();
  if (!runtime.apiKey) return null;

  const prompt = buildClassifierPrompt({
    url: page.url,
    title: page.title,
    metaDescription: page.metaDescription,
    text: page.text,
    websiteLanguage: options.websiteLanguage,
    detection,
  });

  let result;
  try {
    if (runtime.provider === "gemini" || runtime.provider === "google") {
      result = await callGemini({
        model: runtime.model,
        prompt,
        apiKey: runtime.apiKey,
        timeoutMs: runtime.timeoutMs,
      });
    } else {
      result = await callOpenAI({
        model: runtime.model,
        prompt,
        apiKey: runtime.apiKey,
        timeoutMs: runtime.timeoutMs,
      });
    }
  } catch (err) {
    console.warn(
      `[PageContentClassifier] LLM classify failed (${runtime.provider}): ${err.message}`,
    );
    return null;
  }

  if (options.userId && result.usage) {
    try {
      const inputTokens = result.usage.prompt_tokens || 0;
      const outputTokens = result.usage.completion_tokens || 0;
      const costs = computeTokenCosts({
        inputTokens,
        outputTokens,
        cacheTokens: 0,
        inputCostPerMillion: runtime.cfg?.inputCost || 0,
        outputCostPerMillion: runtime.cfg?.outputCost || 0,
        cacheCostPerMillion: runtime.cfg?.cacheCost || 0,
      });
      await logOpenAIUsage({
        userId: options.userId,
        agentId: options.agentId,
        model: result.modelName,
        type: usageTypeForCategory("content-classifier"),
        inputTokens,
        outputTokens,
        cacheTokens: 0,
        totalTokens: result.usage.total_tokens || inputTokens + outputTokens,
        ...costs,
      });
    } catch (logErr) {
      console.warn(
        `[PageContentClassifier] usage log failed: ${logErr.message}`,
      );
    }
  }

  const parsed = parseClassifierJson(result.text);
  if (!parsed) return null;

  return {
    entity_type: normalizeEntityType(parsed.entity_type),
    entity_name:
      typeof parsed.entity_name === "string" && parsed.entity_name.trim()
        ? parsed.entity_name.trim()
        : null,
    search_terms: Array.isArray(parsed.search_terms)
      ? parsed.search_terms.map(String).slice(0, 20)
      : [],
    attributes:
      parsed.attributes && typeof parsed.attributes === "object"
        ? parsed.attributes
        : {},
    classification_confidence:
      typeof parsed.classification_confidence === "number"
        ? parsed.classification_confidence
        : null,
    classification_reason:
      typeof parsed.classification_reason === "string"
        ? parsed.classification_reason
        : "",
    language:
      typeof parsed.language === "string"
        ? parsed.language.toLowerCase().slice(0, 8)
        : null,
    provider: runtime.provider,
    model: result.modelName,
  };
}

function shouldCallLlm(detection) {
  if (!isClassifierEnabled()) return false;
  // Strong schema/metadata: skip LLM; heuristics cover attributes/search_terms
  if (
    (detection.signal === "schema" || detection.signal === "metadata") &&
    detection.confidence >= HIGH_CONFIDENCE_SKIP
  ) {
    return false;
  }
  return true;
}

/**
 * Classify once per page. Returns metadata fields to spread onto all chunks.
 *
 * @param {{
 *   content: string,
 *   metadata?: object,
 *   html?: string,
 *   $?: object,
 *   schemaTypes?: string[],
 * }} doc
 * @param {{ userId?: string, agentId?: string, websiteLanguage?: string }} [options]
 */
async function classifyPageForIngest(doc, options = {}) {
  const metadata = { ...(doc.metadata || {}) };
  const text = doc.content || "";
  const url = metadata.url || "";
  const title = metadata.title || "";
  const metaDescription = metadata.metaDescription || "";

  const detection = detectContentType({
    url,
    title,
    html: doc.html || "",
    text,
    $: doc.$ || null,
    schemaTypes: doc.schemaTypes || metadata.schema_types || null,
    metadataType: metadata.type,
  });

  const source_type = normalizeSourceType(
    metadata.source_type || inferSourceTypeFromMetadata(metadata),
  );

  let llm = null;
  if (shouldCallLlm(detection)) {
    llm = await runLlmClassify(
      { url, title, metaDescription, text },
      detection,
      options,
    );
  }

  const entity_type =
    normalizeEntityType(llm?.entity_type) || detection.entity_type || "general";

  const confidence = calibrateClassificationConfidence(
    detection,
    llm?.classification_confidence,
  );

  const reason =
    llm?.classification_reason ||
    detection.reason ||
    "Deterministic content-type detection";

  const heuristicAttrs = heuristicAttributes({ text, title, url });
  const attributes = mergeAttributes(heuristicAttrs, llm?.attributes || {});
  const projections = projectFilterableAttrs(attributes);

  const heuristicTerms = extractSearchTerms({ text, title, url });
  const search_terms = mergeSearchTerms(
    llm?.search_terms,
    heuristicTerms,
    entity_type ? [entity_type.replace(/_/g, " ")] : [],
    llm?.entity_name ? [llm.entity_name] : [],
  );

  const now = new Date().toISOString();

  return {
    ...metadata,
    source_type,
    entity_type,
    entity_name: llm?.entity_name || metadata.entity_name || null,
    search_terms,
    attributes,
    // Indexed projections for filters/rerank (do not nest-only)
    sizes: projections.sizes.length
      ? projections.sizes
      : extractPayloadAttributes({ text, title, url }).sizes,
    collections: projections.collections.length
      ? projections.collections
      : extractPayloadAttributes({ text, title, url }).collections,
    classification_confidence: confidence,
    classification_reason: reason,
    classification_signal: detection.signal,
    schema_types: detection.schema_types || [],
    content_hash: contentHash(text),
    language: llm?.language || metadata.language || null,
    is_active: true,
    created_at: metadata.created_at || now,
    updated_at: now,
  };
}

module.exports = {
  classifyPageForIngest,
  contentHash,
  extractHeadingPath,
  isClassifierEnabled,
  shouldCallLlm,
  projectFilterableAttrs,
  mergeSearchTerms,
  mergeAttributes,
};
