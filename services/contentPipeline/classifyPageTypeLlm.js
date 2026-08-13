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
const { recordPageTypeLlmUsage } = require("./llmUsageStats");

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

/**
 * PAGE_TYPE_LLM_ENABLED=true|false
 * If unset, falls back to legacy Llama classifier flags (backward compatible).
 */
function isPageTypeLlmEnabled() {
  const explicit = process.env.PAGE_TYPE_LLM_ENABLED;
  if (explicit != null && String(explicit).trim() !== "") {
    return String(explicit).toLowerCase() === "true";
  }
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
 * Low-confidence page-type enrichment via content-classifier.
 * Minimal JSON: pageType, entity_type, confidence, reason (+ optional entity_name).
 * Skips deterministic pages and when PAGE_TYPE_LLM_ENABLED is off.
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
  force = false,
} = {}) {
  if (ruleGuess?.deterministic && !force) {
    recordPageTypeLlmUsage({
      skipped: true,
      skipReason: "deterministic_page",
    });
    return null;
  }

  if (!isPageTypeLlmEnabled()) {
    recordPageTypeLlmUsage({
      skipped: true,
      skipReason: "page_type_llm_disabled",
    });
    return null;
  }

  let cfg;
  try {
    cfg = await getResolvedModelConfig("content-classifier", [
      "content-classifier",
      "open-source",
    ]);
  } catch {
    recordPageTypeLlmUsage({ skipped: true, skipReason: "no_model_config" });
    return null;
  }

  if (!isSupportedChatProvider(cfg.provider) || !cfg.apiKey) {
    recordPageTypeLlmUsage({ skipped: true, skipReason: "provider_unavailable" });
    return null;
  }

  const sample = String(textSample || "").slice(0, 2000);
  const system =
    "Classify one web page for a RAG index. Return valid JSON only. Do not invent prices, SKUs, or stock.";
  const prompt = [
    "Classify this page. Keep the response minimal.",
    `pageType must be one of: ${PAGE_TYPES.join(", ")}`,
    `entity_type must be one of: ${ENTITY_TYPES.join(", ")}`,
    "",
    "For ecommerce:",
    '- entity_type "product" = a single product detail page (PDP), even if related products appear.',
    '- entity_type "listing" = a category/collection/search grid of many products (PLP).',
    "",
    `URL: ${url || ""}`,
    `Title: ${title || ""}`,
    `Meta: ${String(metaDescription || "").slice(0, 240)}`,
    schemaTypes?.length
      ? `Schema.org types: ${schemaTypes.slice(0, 12).join(", ")}`
      : "Schema.org types: none",
    ruleGuess
      ? `Rule guess: pageType=${ruleGuess.pageType}, entity_type=${ruleGuess.entity_type}, confidence=${ruleGuess.confidence}, reason=${ruleGuess.reason || ""}`
      : "Rule guess: none",
    "",
    'Return JSON only: { "pageType": "product", "entity_type": "product", "confidence": 0.0, "reason": "short why", "entity_name": null }',
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
      maxTokens: 120,
    });
    raw = result.text;
    callUsage = result.usage;
  } catch (error) {
    console.warn(`[pageTypeLlm] classification failed: ${error.message}`);
    recordPageTypeLlmUsage({ skipped: true, skipReason: "call_failed" });
    return null;
  }

  const inputTokens = callUsage?.prompt_tokens || callUsage?.input_tokens || 0;
  const outputTokens =
    callUsage?.completion_tokens || callUsage?.output_tokens || 0;
  const cacheTokens = callUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const costs = computeTokenCosts({
    inputTokens,
    outputTokens,
    cacheTokens,
    inputCostPerMillion: cfg.inputCost || 0,
    outputCostPerMillion: cfg.outputCost || 0,
    cacheCostPerMillion: cfg.cacheCost || 0,
  });

  recordPageTypeLlmUsage({
    inputTokens,
    outputTokens,
    cacheTokens,
    estimatedCostUsd: costs.totalCost || 0,
  });

  if (userId) {
    logOpenAIUsage({
      userId,
      agentId,
      conversationId,
      model: cfg.model,
      type: usageTypeForCategory("page-type") || "page-type",
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: callUsage?.total_tokens || inputTokens + outputTokens,
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

  return {
    pageType: pageType || ruleGuess?.pageType || "generic",
    entity_type: entity_type || ruleGuess?.entity_type || "general",
    entity_name:
      typeof parsed.entity_name === "string" && parsed.entity_name.trim()
        ? parsed.entity_name.trim().slice(0, 120)
        : null,
    search_terms: [],
    attributes: {},
    confidence,
    reason: String(parsed.reason || "llm_page_type").slice(0, 200),
    source: "page_type_llm",
    provider: cfg.provider,
  };
}

module.exports = {
  classifyPageTypeLlm,
  isPageTypeLlmEnabled,
};
