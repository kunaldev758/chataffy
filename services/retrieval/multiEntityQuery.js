/**
 * Multi-Entity / Comparison Query Detection
 * ----------------------------------------
 * Detects when a visitor asks about 2+ products/entities in one message:
 *   - Explicit comparison: "A vs B", "compare X and Y", "difference between..."
 *   - Multi-ask: "tell me about A and B", "price of X and Y"
 *
 * Strategy (cheap → expensive):
 *   1. Fast RegEx / pattern split (0 cost)
 *   2. Optional cheap LLM only when comparison intent is clear but entities are messy
 *
 * This module does NOT run retrieval — it only returns structured entities.
 *
 * Env:
 *   ENABLE_MULTI_ENTITY_RETRIEVAL=true|false  (default: true)
 *   MAX_COMPARE_ENTITIES=3                   (default: 3)
 */

const DEFAULT_MAX_ENTITIES = 3;
const LLM_TIMEOUT_MS = 2500;

/**
 * @typedef {Object} MultiEntityDetection
 * @property {boolean} isComparison - true when user wants a side-by-side compare
 * @property {boolean} isMultiAsk - true when multiple entities are asked about (may or may not compare)
 * @property {string[]} entities - cleaned entity strings (2–MAX)
 * @property {string} source - how entities were found (regex | llm | none)
 * @property {boolean} shouldBranch - true when retrieval should use per-entity path
 */

/**
 * Env kill-switch for the multi-entity retrieval branch.
 * @returns {boolean}
 */
function isMultiEntityRetrievalEnabled() {
  const raw = (
    process.env.ENABLE_MULTI_ENTITY_RETRIEVAL || "true"
  ).toLowerCase().trim();
  return !(raw === "false" || raw === "0" || raw === "off");
}

/**
 * Max entities to retrieve for (cost / context cap).
 * @returns {number}
 */
function getMaxEntities() {
  const n = Number(process.env.MAX_COMPARE_ENTITIES);
  return Number.isFinite(n) && n >= 2 ? Math.min(n, 5) : DEFAULT_MAX_ENTITIES;
}

/**
 * Clean a raw entity fragment into a usable search string.
 * @param {string} raw
 * @returns {string}
 */
function cleanEntity(raw) {
  return String(raw || "")
    .replace(/^(compare|the|a|an|difference between|between)\s+/i, "")
    .replace(/\b(please|for me|products?|items?)\b/gi, " ")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop fragments that are too short / generic to be product entities.
 * @param {string} entity
 * @returns {boolean}
 */
function isUsableEntity(entity) {
  if (!entity || entity.length < 2) return false;
  // Pure stop-word-ish fragments
  if (
    /^(and|or|the|a|an|to|with|vs|versus|one|other|both|them|these|those)$/i.test(
      entity,
    )
  ) {
    return false;
  }
  // Need at least one alphanumeric token of length >= 2
  return /\b[a-z0-9][a-z0-9.-]{1,}\b/i.test(entity);
}

/**
 * Dedupe entities case-insensitively while preserving order.
 * @param {string[]} entities
 * @returns {string[]}
 */
function dedupeEntities(entities) {
  const seen = new Set();
  const out = [];
  for (const e of entities) {
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Detect explicit comparison intent keywords.
 * @param {string} qLower
 * @returns {boolean}
 */
function hasComparisonIntent(qLower) {
  return /\b(compare|versus|\bvs\b|difference between|differ from|better than|which is better|which one (?:is better|to buy|should i)|side by side)\b/i.test(
    qLower,
  );
}

/**
 * Tier-1: extract comparison entities via RegEx splits.
 * @param {string} query
 * @returns {{ isComparison: boolean, entities: string[] }}
 */
function parseComparisonEntitiesRegex(query) {
  const q = (query || "").trim();
  const qLower = q.toLowerCase();
  const isComparison = hasComparisonIntent(qLower);
  if (!isComparison) {
    return { isComparison: false, entities: [] };
  }

  let parts = [];

  if (/\bvs\.?\b/i.test(q)) {
    parts = q.split(/\bvs\.?\b/i);
  } else if (/\bversus\b/i.test(q)) {
    parts = q.split(/\bversus\b/i);
  } else if (/\bcompare\b/i.test(qLower)) {
    const after = q.replace(/^.*?\bcompare\b/i, "").trim();
    parts = after.split(/\s+(?:and|with|to|vs\.?|versus)\s+/i);
  } else if (/\bdifference between\b/i.test(qLower)) {
    const after = q.replace(/^.*?\bdifference between\b/i, "").trim();
    parts = after.split(/\s+(?:and|with|vs\.?|versus)\s+/i);
  } else if (/\bwhich is better\b/i.test(qLower) || /\bbetter than\b/i.test(qLower)) {
    // "which is better, A or B" / "A better than B"
    const after = q
      .replace(/^.*?\bwhich is better\b[,:]?\s*/i, "")
      .replace(/\bbetter than\b/i, "|||");
    parts = after.includes("|||")
      ? after.split("|||")
      : after.split(/\s+(?:or|and|vs\.?)\s+/i);
  }

  const entities = dedupeEntities(
    parts.map(cleanEntity).filter(isUsableEntity),
  ).slice(0, getMaxEntities());

  return { isComparison: true, entities };
}

/**
 * Tier-1: multi-ask without explicit "compare" (conservative).
 * Only fires on clear multi-product patterns to avoid false positives
 * like "black and white lashes" (attributes, not two products).
 *
 * @param {string} query
 * @returns {string[]}
 */
function parseMultiAskEntitiesRegex(query) {
  const q = (query || "").trim();
  if (!q) return [];

  // "both A and B"
  const bothMatch = q.match(
    /\bboth\s+(.+?)\s+and\s+(.+?)(?:\?|$|,|\.|$)/i,
  );
  if (bothMatch) {
    return dedupeEntities(
      [bothMatch[1], bothMatch[2]].map(cleanEntity).filter(isUsableEntity),
    ).slice(0, getMaxEntities());
  }

  // "A as well as B" / "A along with B"
  const asWell = q.match(
    /^(.{3,80}?)\s+(?:as well as|along with)\s+(.{3,80?}?)(?:\?|$)/i,
  );
  if (asWell) {
    return dedupeEntities(
      [asWell[1], asWell[2]].map(cleanEntity).filter(isUsableEntity),
    ).slice(0, getMaxEntities());
  }

  // "tell me about A and B" / "price of A and B" / "details on A and B"
  const aboutMatch = q.match(
    /\b(?:tell me about|what about|price of|prices? for|details? (?:on|for|about)|info(?:rmation)? (?:on|about)|how much (?:is|are))\s+(.+?)\s+and\s+(.+?)(?:\?|$)/i,
  );
  if (aboutMatch) {
    const entities = dedupeEntities(
      [aboutMatch[1], aboutMatch[2]].map(cleanEntity).filter(isUsableEntity),
    );
    // Require each side to look like a meaningful phrase (avoid "black and white")
    if (
      entities.length >= 2 &&
      entities.every((e) => e.split(/\s+/).length >= 1 && e.length >= 3)
    ) {
      // Heuristic: skip if both sides are only color/size adjectives
      const colorOnly =
        /^(black|white|red|blue|green|pink|brown|navy|grey|gray|gold|silver)$/i;
      if (entities.every((e) => colorOnly.test(e))) {
        return [];
      }
      return entities.slice(0, getMaxEntities());
    }
  }

  // "A, B, and C" with compare-ish verbs already handled above; optional list of products
  // Keep disabled for bare comma lists — too many false positives.

  return [];
}

/**
 * Optional LLM entity extraction when comparison intent is clear but regex failed.
 *
 * @param {string} query
 * @param {object} options
 * @param {import("openai").OpenAI} [options.openaiClient]
 * @param {string} [options.modelName]
 * @param {Function} [options.logOpenAIUsage]
 * @returns {Promise<string[]>}
 */
async function extractEntitiesWithLlm(query, options = {}) {
  const { openaiClient, modelName, logOpenAIUsage } = options;
  if (!openaiClient || !modelName) return [];

  const system = `You extract product/entity names from comparison or multi-product questions.
Return ONLY valid JSON: { "entities": ["name1", "name2"] }
Extract 2-3 product or item names being compared or asked about together.
Do not invent names. If unsure, return { "entities": [] }.`;

  const user = `Query: "${String(query).replace(/"/g, '\\"')}"`;

  try {
    const llmPromise = openaiClient.chat.completions
      .create({
        model: modelName,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
      })
      .then((res) => ({
        text: String(res.choices?.[0]?.message?.content || "").trim(),
        usage: res.usage || null,
      }))
      .catch(() => ({ text: "", usage: null }));

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ text: "", usage: null }), LLM_TIMEOUT_MS),
    );

    const result = await Promise.race([llmPromise, timeoutPromise]);

    if (result.usage && typeof logOpenAIUsage === "function") {
      Promise.resolve(
        logOpenAIUsage({
          usage: result.usage,
          modelName,
          type: "intent",
        }),
      ).catch(() => {});
    }

    if (!result.text) return [];
    const parsed = JSON.parse(result.text);
    const entities = dedupeEntities(
      (Array.isArray(parsed.entities) ? parsed.entities : [])
        .map(cleanEntity)
        .filter(isUsableEntity),
    ).slice(0, getMaxEntities());

    return entities.length >= 2 ? entities : [];
  } catch (err) {
    console.warn(
      `[multiEntityQuery] LLM entity extract failed: ${err.message}`,
    );
    return [];
  }
}

/**
 * Detect comparison / multi-entity structure for a visitor query.
 *
 * @param {string} query - Prefer lexical/standalone search query
 * @param {object} [options] - openaiClient, modelName, logOpenAIUsage
 * @returns {Promise<MultiEntityDetection>}
 */
async function detectMultiEntityQuery(query, options = {}) {
  const trimmed = (query || "").trim();

  if (!isMultiEntityRetrievalEnabled() || !trimmed) {
    return {
      isComparison: false,
      isMultiAsk: false,
      entities: [],
      source: "disabled",
      shouldBranch: false,
    };
  }

  // --- Tier 1a: explicit comparison ---
  const comparison = parseComparisonEntitiesRegex(trimmed);
  if (comparison.isComparison && comparison.entities.length >= 2) {
    console.log(
      `[multiEntityQuery] Comparison (regex): ${comparison.entities.join(" vs ")}`,
    );
    return {
      isComparison: true,
      isMultiAsk: true,
      entities: comparison.entities,
      source: "regex_compare",
      shouldBranch: true,
    };
  }

  // --- Tier 1b: multi-ask without "compare" ---
  const multiAsk = parseMultiAskEntitiesRegex(trimmed);
  if (multiAsk.length >= 2) {
    console.log(
      `[multiEntityQuery] Multi-ask (regex): ${multiAsk.join(" | ")}`,
    );
    return {
      isComparison: false,
      isMultiAsk: true,
      entities: multiAsk,
      source: "regex_multi",
      shouldBranch: true,
    };
  }

  // --- Tier 2: LLM fallback disabled by default (entity resolution uses history/rules).
  // Set ENABLE_MULTI_ENTITY_LLM=true to re-enable for messy compare phrasing only.
  const llmEnabled =
    (process.env.ENABLE_MULTI_ENTITY_LLM || "false").toLowerCase().trim() ===
    "true";
  if (llmEnabled && comparison.isComparison) {
    const llmEntities = await extractEntitiesWithLlm(trimmed, options);
    if (llmEntities.length >= 2) {
      console.log(
        `[multiEntityQuery] Comparison (llm): ${llmEntities.join(" vs ")}`,
      );
      return {
        isComparison: true,
        isMultiAsk: true,
        entities: llmEntities,
        source: "llm_compare",
        shouldBranch: true,
      };
    }
  }

  return {
    isComparison: false,
    isMultiAsk: false,
    entities: [],
    source: "none",
    shouldBranch: false,
  };
}

module.exports = {
  detectMultiEntityQuery,
  parseComparisonEntitiesRegex,
  parseMultiAskEntitiesRegex,
  isMultiEntityRetrievalEnabled,
  getMaxEntities,
  cleanEntity,
  dedupeEntities,
  isUsableEntity,
  hasComparisonIntent,
};
