const { logOpenAIUsage, computeTokenCosts } = require("../UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("../aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("../providerChatComplete");
const { ENTITY_TYPES } = require("./schema");
const { recordSectionLlmUsage } = require("./llmUsageStats");

/** Hard caps to keep section LLM cheap when enabled. */
const MAX_SECTIONS_PER_CALL = 5;
const MAX_BATCHES_PER_PAGE = 1;
const SECTION_EXCERPT_CHARS = 600;

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
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    const parsed = safeJsonParse(arr[0]);
    if (parsed) return parsed;
  }
  const brace = raw.match(/\{[\s\S]*\}/);
  return brace ? safeJsonParse(brace[0]) : safeJsonParse(raw);
}

/**
 * SECTION_LLM_ENABLED=true|false
 * Defaults to false when unset (separate from page-type LLM; cost-safe).
 */
function isSectionLlmEnabled() {
  const explicit = process.env.SECTION_LLM_ENABLED;
  if (explicit != null && String(explicit).trim() !== "") {
    return String(explicit).toLowerCase() === "true";
  }
  return false;
}

function normalizeEntityType(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  if (v === "other" || v === "generic") return "general";
  return ENTITY_TYPES.includes(v) ? v : null;
}

/**
 * Batched low-confidence section classification.
 * Minimal JSON per row: id, entity_type, confidence, reason (+ optional entity_name).
 *
 * @returns {Promise<Array<{ id, entity_type, entity_name, confidence, reason }>|null>}
 */
async function classifySectionsLlm({
  pageType = "generic",
  sections = [],
  userId = null,
  agentId = null,
  conversationId = null,
  deterministicPage = false,
  force = false,
} = {}) {
  if (deterministicPage && !force) {
    recordSectionLlmUsage({
      skipped: true,
      skipReason: "deterministic_page",
    });
    return null;
  }

  if (!isSectionLlmEnabled()) {
    recordSectionLlmUsage({
      skipped: true,
      skipReason: "section_llm_disabled",
    });
    return null;
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    recordSectionLlmUsage({ skipped: true, skipReason: "no_sections" });
    return null;
  }

  let cfg;
  try {
    cfg = await getResolvedModelConfig("content-classifier", [
      "content-classifier",
      "open-source",
    ]);
  } catch {
    recordSectionLlmUsage({ skipped: true, skipReason: "no_model_config" });
    return null;
  }

  if (!isSupportedChatProvider(cfg.provider) || !cfg.apiKey) {
    recordSectionLlmUsage({ skipped: true, skipReason: "provider_unavailable" });
    return null;
  }

  // Cap sections + batches for cost control
  const capped = sections.slice(0, MAX_SECTIONS_PER_CALL * MAX_BATCHES_PER_PAGE);
  const payload = capped.map((s) => ({
    id: s.id,
    heading: String(s.heading || "").slice(0, 120),
    excerpt: String(s.content || "").slice(0, SECTION_EXCERPT_CHARS),
    rule_guess: s.ruleGuess?.entity_type || null,
  }));

  const system =
    "Classify leftover page sections for a RAG index. Return valid JSON only. Do not invent prices or SKUs.";
  const prompt = [
    `Page pageType="${pageType}". Classify each section.`,
    `entity_type must be one of: ${ENTITY_TYPES.join(", ")}`,
    'Prefer "general" when unsure. Use faq/review/policy/docs/about when clear.',
    "",
    "Return a JSON array only (include every id):",
    '[{ "id": "c0", "entity_type": "faq", "confidence": 0.0, "reason": "short why", "entity_name": null }]',
    "",
    "Sections:",
    JSON.stringify(payload),
  ].join("\n");

  let raw = "";
  let callUsage = null;
  try {
    const result = await providerChatComplete({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs || 45000,
      system,
      temperature: 0,
      maxTokens: Math.min(400, 80 + capped.length * 60),
    });
    raw = result.text;
    callUsage = result.usage;
  } catch (error) {
    console.warn(`[sectionLlm] batch classification failed: ${error.message}`);
    recordSectionLlmUsage({ skipped: true, skipReason: "call_failed" });
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

  recordSectionLlmUsage({
    batches: 1,
    sectionsClassified: capped.length,
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
      console.warn(`[sectionLlm] usage log error: ${err.message}`),
    );
  }

  const parsed = extractJsonFromText(raw);
  let rows = [];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && Array.isArray(parsed.sections)) {
    rows = parsed.sections;
  } else if (parsed && typeof parsed === "object" && parsed.id) {
    rows = [parsed];
  } else {
    return null;
  }

  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const entity_type = normalizeEntityType(row.entity_type);
      if (!row.id && !entity_type) return null;
      const confidence =
        typeof row.confidence === "number"
          ? Math.max(0, Math.min(1, row.confidence))
          : 0.55;
      return {
        id: String(row.id || ""),
        entity_type: entity_type || "general",
        entity_name:
          typeof row.entity_name === "string" && row.entity_name.trim()
            ? row.entity_name.trim().slice(0, 120)
            : null,
        search_terms: [],
        attributes: {},
        confidence,
        reason: String(row.reason || "llm_section").slice(0, 200),
        source: "section_llm",
        provider: cfg.provider,
      };
    })
    .filter(Boolean);
}

module.exports = {
  classifySectionsLlm,
  isSectionLlmEnabled,
  MAX_SECTIONS_PER_CALL,
  MAX_BATCHES_PER_PAGE,
};
