const { logOpenAIUsage, computeTokenCosts } = require("./UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("./providerChatComplete");

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

/**
 * Classify website type using the active superadmin model for
 * `website-classifier` (openai or groq; env fallback when no DB model).
 */
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

  let cfg;
  try {
    cfg = await getResolvedModelConfig("website-classifier", ["open-source"]);
  } catch {
    return null;
  }

  if (!isSupportedChatProvider(cfg.provider) || !cfg.apiKey) return null;

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
  try {
    const result = await providerChatComplete({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || 30000,
      system,
      temperature: 0,
      maxTokens: 200,
    });
    raw = result.text;
    callUsage = result.usage;
  } catch (error) {
    console.warn(
      "[LlamaWebsiteClassifier] classification failed:",
      error.message,
    );
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
    source: "website_classifier",
    provider: cfg.provider,
    raw,
  };
}

module.exports = {
  WEBSITE_TYPES,
  classifyWebsiteType,
  isWebsiteTypeClassifierEnabled,
};
