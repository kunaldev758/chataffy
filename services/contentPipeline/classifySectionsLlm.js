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
const { isPageTypeLlmEnabled } = require("./classifyPageTypeLlm");

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

function normalizeEntityType(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  if (v === "other" || v === "generic") return "general";
  return ENTITY_TYPES.includes(v) ? v : null;
}

/**
 * Batched low-confidence section classification via content-classifier.
 * Returns an array aligned by section `id`. Never invents prices/SKUs.
 *
 * @returns {Promise<Array<{ id, entity_type, entity_name, search_terms, attributes, confidence, reason }>|null>}
 */
async function classifySectionsLlm({
  pageType = "generic",
  sections = [],
  userId = null,
  agentId = null,
  conversationId = null,
} = {}) {
  if (!isPageTypeLlmEnabled()) return null;
  if (!Array.isArray(sections) || sections.length === 0) return null;

  let cfg;
  try {
    cfg = await getResolvedModelConfig("content-classifier", [
      "content-classifier",
      "open-source",
    ]);
  } catch {
    return null;
  }

  if (!isSupportedChatProvider(cfg.provider) || !cfg.apiKey) return null;

  const payload = sections.map((s) => ({
    id: s.id,
    heading: String(s.heading || "").slice(0, 160),
    excerpt: String(s.content || "").slice(0, 1800),
    rule_guess: s.ruleGuess
      ? `${s.ruleGuess.entity_type || "general"}@${s.ruleGuess.confidence ?? "?"}`
      : null,
  }));

  const system =
    "You classify leftover page sections for a RAG index. Return valid JSON only. Do not invent product prices, SKUs, or stock status.";
  const prompt = [
    `Page-level pageType is "${pageType}". Classify each section independently.`,
    `entity_type must be one of: ${ENTITY_TYPES.join(", ")}`,
    "For ambiguous blocks prefer \"general\". Use \"faq\", \"review\", \"policy\", \"docs\", \"about\" when clearly indicated.",
    "Also return entity_name (short, or null), optional search_terms (max 8), optional attributes (only clearly stated).",
    "Do NOT suggest related_product_urls or invent commerce fields.",
    "",
    "Return a JSON array (same order / include every id):",
    '[{ "id": "c0", "entity_type": "faq", "entity_name": "...", "search_terms": [], "attributes": {}, "confidence": 0.0, "reason": "..." }]',
    "",
    "Sections:",
    JSON.stringify(payload, null, 2),
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
      maxTokens: Math.min(900, 120 + sections.length * 140),
    });
    raw = result.text;
    callUsage = result.usage;
  } catch (error) {
    console.warn(`[sectionLlm] batch classification failed: ${error.message}`);
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
      type: usageTypeForCategory("content-classifier") || "content-classifier",
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: callUsage.total_tokens || inputTokens + outputTokens,
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
      const search_terms = Array.isArray(row.search_terms)
        ? row.search_terms
            .map((t) => String(t).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const attributes =
        row.attributes && typeof row.attributes === "object"
          ? { ...row.attributes }
          : {};
      // Strip commerce inventions from section LLM
      for (const key of ["sku", "price", "currency", "in_stock", "mpn"]) {
        delete attributes[key];
      }
      return {
        id: String(row.id || ""),
        entity_type: entity_type || "general",
        entity_name:
          typeof row.entity_name === "string" && row.entity_name.trim()
            ? row.entity_name.trim()
            : null,
        search_terms,
        attributes,
        confidence,
        reason: row.reason || "llm_section",
        source: "section_llm",
        provider: cfg.provider,
      };
    })
    .filter(Boolean);
}

module.exports = {
  classifySectionsLlm,
};
