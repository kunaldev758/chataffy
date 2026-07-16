const axios = require("axios");
const { logOpenAIUsage, computeTokenCosts } = require("./UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");

const WEBSITE_TYPES = [
  "E-commerce Website",
  "SaaS Website",
  "Job Portal",
  "Real Estate Website",
  "Healthcare Website",
  "Banking/Finance Website",
  "Educational Website",
  "News Website",
  "Blog Website",
  "Government Website",
  "Nonprofit Website",
  "Crowdfunding Website",
  "Booking Website",
  "Streaming Website",
  "Entertainment Website",
  "Media Sharing Website",
  "Social Media Website",
  "Forum/Community Website",
  "Wiki Website",
  "Search Engine",
  "Documentation Website",
  "Knowledge Base",
  "Membership Website",
  "Directory Website",
  "Portfolio Website",
  "Personal Website",
  "Landing Page",
  "Web Application",
  "Business/Corporate Website",
];

const INDUSTRIES = [
  "technology",
  "healthcare",
  "real estate",
  "finance",
  "education",
  "retail",
];

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

function normalizeCompanyType(raw) {
  if (!raw) return null;
  const normalized = String(raw).trim();
  const exact = WEBSITE_TYPES.find(
    (type) => type.toLowerCase() === normalized.toLowerCase(),
  );
  if (exact) return exact;

  const partial = WEBSITE_TYPES.find((type) =>
    normalized.toLowerCase().includes(type.toLowerCase()),
  );
  return partial || null;
}

function normalizeIndustry(raw) {
  if (!raw) return null;
  const normalized = String(raw).trim().toLowerCase();
  return INDUSTRIES.find((industry) => industry === normalized) || null;
}

function isWebsiteTypeClassifierEnabled() {
  const explicit = process.env.LLAMA_WEBSITE_TYPE_ENABLED;
  if (explicit != null && String(explicit).trim() !== "") {
    return String(explicit).toLowerCase() === "true";
  }
  return (
    String(process.env.LLAMA_ENABLED || "").toLowerCase() === "true" ||
    String(process.env.LLAMA_MICRO_ENABLED || "").toLowerCase() === "true"
  );
}

function buildClassifierPrompt({
  url,
  title,
  description,
  pageContent,
  schemaTypes,
}) {
  const content = String(pageContent || "").slice(0, 48000);

  return [
    "You classify websites by reading their page content.",
    "Respond with JSON only (no markdown, no extra text).",
    "",
    "Pick exactly one company_type from this list:",
    WEBSITE_TYPES.map((type) => `- ${type}`).join("\n"),
    "",
    "Pick industry only when clear, using one of:",
    INDUSTRIES.join(", "),
    "Otherwise use an empty string for industry.",
    "",
    "Rules:",
    "- Base the decision on the full page content, not just the domain name.",
    "- Prefer the most specific type that fits the site's primary purpose.",
    "- Use Business/Corporate Website only when nothing else fits.",
    "",
    `URL: ${url || ""}`,
    `Title: ${title || ""}`,
    `Meta description: ${description || ""}`,
    schemaTypes?.length
      ? `Schema.org types found: ${schemaTypes.join(", ")}`
      : "Schema.org types found: none",
    "",
    "Return JSON shape:",
    '{ "company_type": "SaaS Website", "industry": "technology", "confidence": 0.9 }',
    "",
    "Page content:",
    content,
  ].join("\n");
}

async function callOllama({ model, prompt, baseUrl, timeoutMs, system }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    url,
    {
      model,
      messages,
      stream: false,
      options: { temperature: 0 },
    },
    { timeout: timeoutMs },
  );
  const text = String(res.data?.message?.content || res.data?.response || "").trim();
  const usage =
    res.data?.eval_count != null
      ? {
          prompt_tokens: res.data.prompt_eval_count || 0,
          completion_tokens: res.data.eval_count || 0,
          total_tokens:
            (res.data.prompt_eval_count || 0) + (res.data.eval_count || 0),
        }
      : null;
  return { text, usage };
}

async function callGroq({ model, prompt, apiKey, timeoutMs, system }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    url,
    {
      model,
      temperature: 0,
      max_tokens: 200,
      messages,
    },
    {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  const text = String(res.data?.choices?.[0]?.message?.content || "").trim();
  const usage = res.data?.usage || null;
  return { text, usage };
}

async function classifyWebsiteType({
  url,
  title,
  description,
  pageContent,
  schemaTypes = [],
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  if (!isWebsiteTypeClassifierEnabled()) return null;

  const provider = String(
    process.env.LLAMA_WEBSITE_TYPE_PROVIDER ||
      process.env.LLAMA_MICRO_PROVIDER ||
      "grok",
  ).toLowerCase();
  const timeoutMs = Number(process.env.LLAMA_WEBSITE_TYPE_TIMEOUT_MS) || 30000;
  const system =
    "You are a website classification assistant. Return valid JSON only.";

  const prompt = buildClassifierPrompt({
    url,
    title,
    description,
    pageContent,
    schemaTypes,
  });

  let raw = "";
  let callUsage = null;
  let callModel = process.env.LLAMA_WEBSITE_TYPE_MODEL || "llama-3.1-8b-instant";
  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return null;
      callModel = process.env.LLAMA_WEBSITE_TYPE_MODEL || "llama-3.1-8b-instant";
      const result = await callGroq({
        model: callModel,
        prompt,
        apiKey,
        timeoutMs,
        system,
      });
      raw = result.text;
      callUsage = result.usage;
    } else {
      const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
      callModel = process.env.LLAMA_WEBSITE_TYPE_MODEL || "llama-3.1-8b-instant";
      const result = await callOllama({
        model: callModel,
        prompt,
        baseUrl,
        timeoutMs,
        system,
      });
      raw = result.text;
      callUsage = result.usage;
    }
  } catch (error) {
    console.warn(
      "[LlamaWebsiteClassifier] classification failed:",
      error.message,
    );
    return null;
  }

  if (callUsage && userId) {
    let cfg = null;
    try {
      cfg = await getResolvedModelConfig("website-classifier", ["open-source"]);
    } catch {
      cfg = null;
    }
    const inputTokens = callUsage.prompt_tokens || callUsage.input_tokens || 0;
    const outputTokens =
      callUsage.completion_tokens || callUsage.output_tokens || 0;
    const cacheTokens = callUsage?.prompt_tokens_details?.cached_tokens ?? 0;
    const costs = computeTokenCosts({
      inputTokens,
      outputTokens,
      cacheTokens,
      inputCostPerMillion: cfg?.inputCost || 0,
      outputCostPerMillion: cfg?.outputCost || 0,
      cacheCostPerMillion: cfg?.cacheCost || 0,
    });

    logOpenAIUsage({
      userId,
      agentId,
      conversationId,
      model: callModel,
      type: usageTypeForCategory("website-classifier"),
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: callUsage.total_tokens || inputTokens + outputTokens,
      ...costs,
    }).catch((err) =>
      console.warn(
        `[LlamaWebsiteClassifier] Error logging usage: ${err.message}`,
      ),
    );
  }

  const parsed = extractJsonFromText(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const companyType = normalizeCompanyType(parsed.company_type);
  if (!companyType) return null;

  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.7;

  return {
    company_type: companyType,
    industry: normalizeIndustry(parsed.industry) || "",
    confidence,
    source: "llama_website_classifier",
    provider,
    raw,
  };
}

module.exports = {
  WEBSITE_TYPES,
  classifyWebsiteType,
  isWebsiteTypeClassifierEnabled,
};
