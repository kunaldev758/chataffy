const { logOpenAIUsage, computeTokenCosts } = require("../UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("../aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("../providerChatComplete");
const { PAGE_TYPES, ENTITY_TYPES } = require("./schema");

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonFromText(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed) return parsed;
  }
  const brace = raw.match(/\{[\s\S]*\}/);
  return brace ? safeJsonParse(brace[0]) : safeJsonParse(raw);
}

function isPageTypeLlmEnabled() {
  const explicit = process.env.PAGE_TYPE_LLM_ENABLED;
  if (explicit != null && String(explicit).trim() !== "") {
    return String(explicit).toLowerCase() === "true";
  }
  // Reuse website-classifier enable flags as default
  return (
    String(process.env.LLAMA_WEBSITE_TYPE_ENABLED || "").toLowerCase() ===
      "true" ||
    String(process.env.LLAMA_ENABLED || "").toLowerCase() === "true" ||
    String(process.env.LLAMA_MICRO_ENABLED || "").toLowerCase() === "true"
  );
}

function normalizePageType(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  return PAGE_TYPES.includes(v) ? v : null;
}

function normalizeEntityType(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  return ENTITY_TYPES.includes(v) ? v : null;
}

/**
 * Low-confidence page-type enrichment via groq/openai (not Gemini).
 * Only fills classification fields — never invents prices/SKUs.
 */
async function classifyPageTypeLlm({
  url,
  title,
  metaDescription,
  schemaTypes = [],
  textSample = "",
  ruleGuess = null,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  if (!isPageTypeLlmEnabled()) return null;

  let cfg;
  try {
    cfg = await getResolvedModelConfig("page-type", [
      "website-classifier",
      "open-source",
    ]);
  } catch {
    return null;
  }

  if (!isSupportedChatProvider(cfg.provider) || !cfg.apiKey) return null;

  const sample = String(textSample || "").slice(0, 6000);
  const system =
    "You classify web pages for a RAG index. Return valid JSON only. Do not invent product prices, SKUs, or stock status.";
  const prompt = [
    "Classify this page.",
    `pageType must be one of: ${PAGE_TYPES.join(", ")}`,
    `entity_type must be one of: ${ENTITY_TYPES.join(", ")}`,
    "Also return entity_name (short, or null) and optional search_terms (string array, max 12).",
    "Only suggest attributes that are clearly stated (no guessing). Prefer empty attributes over invented ones.",
    "",
    `URL: ${url || ""}`,
    `Title: ${title || ""}`,
    `Meta: ${metaDescription || ""}`,
    schemaTypes?.length
      ? `Schema.org types: ${schemaTypes.join(", ")}`
      : "Schema.org types: none",
    ruleGuess
      ? `Rule guess: pageType=${ruleGuess.pageType}, entity_type=${ruleGuess.entity_type}, confidence=${ruleGuess.confidence}`
      : "Rule guess: none",
    "",
    'Return JSON: { "pageType": "product", "entity_type": "product", "entity_name": "...", "search_terms": [], "attributes": {}, "confidence": 0.0, "reason": "..." }',
    "",
    "Page excerpt:",
    sample,
  ].join("\n");

  let raw = "";
  let callUsage = null;
  try {
    const result = await providerChatComplete({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || 30000,
      system,
      temperature: 0,
      maxTokens: 280,
    });
    raw = result.text;
    callUsage = result.usage;
  } catch (error) {
    console.warn(`[pageTypeLlm] classification failed: ${error.message}`);
    return null;
  }

  if (callUsage && userId) {
    const inputTokens = callUsage.prompt_tokens || callUsage.input_tokens || 0;
    const outputTokens =
      callUsage.completion_tokens || callUsage.output_tokens || 0;
    const cacheTokens = callUsage?.prompt_tokens_details?.cached_tokens ?? 0;
    const costs = computeTokenCosts({
      inputTokens,
      outputTokens,
      cacheTokens,
      inputCostPerMillion: cfg.inputCost || 0,
      outputCostPerMillion: cfg.outputCost || 0,
      cacheCostPerMillion: cfg.cacheCost || 0,
    });

    logOpenAIUsage({
      userId,
      agentId,
      conversationId,
      model: cfg.model,
      type: usageTypeForCategory("page-type") || "page-type",
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: callUsage.total_tokens || inputTokens + outputTokens,
      ...costs,
    }).catch((err) =>
      console.warn(`[pageTypeLlm] usage log error: ${err.message}`),
    );
  }

  const parsed = extractJsonFromText(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const pageType = normalizePageType(parsed.pageType);
  const entity_type = normalizeEntityType(parsed.entity_type);
  if (!pageType && !entity_type) return null;

  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.55;

  const search_terms = Array.isArray(parsed.search_terms)
    ? parsed.search_terms
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const attributes =
    parsed.attributes && typeof parsed.attributes === "object"
      ? { ...parsed.attributes }
      : {};

  // Strip dangerous invented commerce fields if present without clear numeric evidence
  // (validation layer will also prefer deterministic attrs)
  return {
    pageType: pageType || ruleGuess?.pageType || "generic",
    entity_type: entity_type || ruleGuess?.entity_type || "general",
    entity_name:
      typeof parsed.entity_name === "string" && parsed.entity_name.trim()
        ? parsed.entity_name.trim()
        : null,
    search_terms,
    attributes,
    confidence,
    reason: parsed.reason || "llm_page_type",
    source: "page_type_llm",
    provider: cfg.provider,
  };
}

module.exports = {
  classifyPageTypeLlm,
  isPageTypeLlmEnabled,
};
