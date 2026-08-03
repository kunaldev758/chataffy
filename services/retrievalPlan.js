/**
 * Intent-driven Retrieval Plan.
 *
 * Orchestrates the pipeline:
 *   routing.constraints[] --(constraintFacetMapper, pure transform)--> facets[]
 *   facets[] --(retrievalPolicy, decides usage)--> hardFilters/softBoosts/lexicalHints
 *
 * This module wires the two together and adds the retrieval-depth /
 * context-mode policy (topK, contextMode, tokenBudget) that is orthogonal
 * to facet classification. It does NOT decide hard/soft/lexical itself —
 * that lives in retrievalPolicy.js so tenant-specific retrieval strategy
 * never has to touch the mapper.
 *
 * Industry pattern: retrieve deep → multi-signal rerank → take top-N by rank.
 * RRF fusion scores are rank-based — never gate on absolute thresholds.
 */

const { mapConstraintsToFacets } = require("./constraintFacetMapper");
const {
  applyRetrievalPolicy,
  DEFAULT_HARD_FILTER_KEYS,
  DEFAULT_HARD_FILTER_MIN_CONFIDENCE,
} = require("./retrievalPolicy");
const { PAGE_TYPES } = require("./contentPipeline/schema");

const PAGE_TYPE_SET = new Set(PAGE_TYPES);

/**
 * @typedef {Object} Facet
 * @property {string} key
 * @property {string} value
 * @property {string} operator
 * @property {number} confidence
 * @property {string} source
 */

/**
 * @typedef {Object} RetrievalPlan
 * @property {string} intent
 * @property {string|null} subIntent
 * @property {Facet[]} facets
 * @property {string[]} lexicalTerms
 * @property {object} retrievalPolicy
 * @property {object} queryAttributes - passthrough for rerank compat
 */

function normalizeFacetValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Heuristic facet fallback, used only when the intent router produced no
 * constraints (e.g. a rule-engine short-circuit route that never called
 * the LLM). Once constraints are present, they are the single source of
 * truth for facets — this is a compatibility shim, not the primary path.
 */
function buildHeuristicFacets(queryAttributes = {}) {
  const facets = [];

  for (const size of queryAttributes.sizes || []) {
    const value = normalizeFacetValue(size);
    if (!value) continue;
    facets.push({
      key: "size",
      value,
      operator: "eq",
      confidence: 0.85,
      source: "inferred",
    });
  }

  for (const collection of queryAttributes.collections || []) {
    const value = normalizeFacetValue(collection);
    if (!value) continue;
    facets.push({
      key: "collection",
      value,
      operator: "eq",
      confidence: 0.75,
      source: "inferred",
    });
  }

  if (queryAttributes.subIntent === "IN_PAGE_LIST") {
    facets.push({
      key: "intent_signal",
      value: "price",
      operator: "eq",
      confidence: 0.7,
      source: "inferred",
    });
  }

  return facets;
}

function buildLexicalTerms(queryAttributes = {}, facets = [], routing = {}) {
  const terms = new Set();

  for (const rt of routing.lexicalTerms || []) {
    const t = normalizeFacetValue(rt);
    if (t.length > 1) terms.add(t);
  }

  for (const kw of queryAttributes.keywords || []) {
    const t = normalizeFacetValue(kw);
    if (t.length > 1) terms.add(t);
  }

  for (const f of facets) {
    if (f.key === "pageType") continue;
    if (f.value) terms.add(f.value);
    if (f.key === "size") {
      const num = f.value.replace(/\s/g, "").replace(/mm$/i, "");
      if (num.length > 0) terms.add(num);
    }
  }

  const source = queryAttributes.keywordSource || queryAttributes.retrievalQuery || "";
  for (const m of String(source).matchAll(/\b[A-Za-z0-9][A-Za-z0-9_.-]{2,}\b/g)) {
    terms.add(m[0].toLowerCase());
  }

  return [...terms].slice(0, 40);
}

function mapTargetPageTypesToFacets(targetPageTypes = []) {
  if (!Array.isArray(targetPageTypes)) return [];

  return targetPageTypes
    .filter(
      (target) =>
        target &&
        PAGE_TYPE_SET.has(String(target.type || "").trim().toLowerCase()),
    )
    .map((target) => ({
      // Preserve payload casing: this maps directly to Qdrant's `pageType`.
      key: "pageType",
      value: String(target.type).trim().toLowerCase(),
      operator: "eq",
      confidence: Math.max(0, Math.min(1, Number(target.confidence) || 0)),
      source: "inferred",
    }))
    .slice(0, 3);
}

function resolveContextMode(subIntent) {
  if (subIntent === "IN_PAGE_LIST") return "list";
  if (subIntent === "PAGE_LINKS") return "links";
  if (subIntent === "CONTACT_INFO") return "contact";
  if (subIntent === "COMPARE") return "page_merge";
  // Industry default: top ranked chunks, not whole-page merge
  return "parent_chunks";
}

function resolveTokenBudget(contextMode) {
  switch (contextMode) {
    case "list":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_LIST) || 3000;
    case "links":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_LINKS) || 3000;
    case "page_merge":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS) || 4000;
    case "contact":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
    default:
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
  }
}

/**
 * Deep candidate pool for RRF + rerank; finalTopK stays small for context.
 * Industry: prefetch 50–100 per channel, keep ~12–15 for the LLM.
 */
function resolveTopK(subIntent, requestedTopK = 10) {
  if (subIntent === "IN_PAGE_LIST") {
    return {
      topKDense: 80,
      topKSparse: 80,
      finalTopK: Math.max(15, Math.min(20, requestedTopK * 2)),
      semanticTopK: 80,
    };
  }
  if (subIntent === "CONTACT_INFO") {
    return {
      topKDense: 50,
      topKSparse: 50,
      finalTopK: 12,
      semanticTopK: 50,
    };
  }
  if (subIntent === "PAGE_LINKS") {
    return {
      topKDense: 60,
      topKSparse: 60,
      finalTopK: Math.max(12, Math.min(18, requestedTopK * 2)),
      semanticTopK: 60,
    };
  }
  return {
    topKDense: 60,
    topKSparse: 60,
    finalTopK: Math.max(12, Math.min(15, requestedTopK)),
    semanticTopK: 60,
  };
}

/**
 * @param {object} params
 * @param {object} params.routing - from routeQuery (route, subIntent, lexicalTerms, constraints)
 * @param {object} params.queryAttributes - from extractQueryAttributes (fallback facet source only)
 * @param {number} [params.requestedTopK]
 * @param {object} [params.tenantPolicy] - per-tenant retrieval policy overrides
 */
function buildRetrievalPlan({
  routing = {},
  queryAttributes = {},
  requestedTopK = 10,
  tenantPolicy = {},
} = {}) {
  const intent = routing.route || queryAttributes.route || "SEMANTIC_RAG";
  const subIntent =
    queryAttributes.subIntent || routing.subIntent || null;

  // Constraints from the intent router are the source of truth for facets.
  // Heuristic extraction only fills in when the router provided none.
  const routerFacets = mapConstraintsToFacets(routing.constraints);
  const baseFacets =
    routerFacets.length > 0 ? routerFacets : buildHeuristicFacets(queryAttributes);
  const pageTypeFacets = mapTargetPageTypesToFacets(routing.targetPageTypes);
  const facets = [...baseFacets, ...pageTypeFacets];

  const baseLexicalTerms = buildLexicalTerms(queryAttributes, facets, routing);
  const contextMode = resolveContextMode(subIntent);
  const tokenBudget = resolveTokenBudget(contextMode);
  const topK = resolveTopK(subIntent, requestedTopK);

  // Policy engine decides hard filter / soft boost / lexical hint per facet.
  const policy = applyRetrievalPolicy({
    intent,
    subIntent,
    facets,
    lexicalTerms: baseLexicalTerms,
    tenantPolicy,
  });

  /** @type {RetrievalPlan} */
  const plan = {
    intent,
    subIntent,
    facets,
    lexicalTerms: policy.lexicalTerms,
    queryAttributes,
    retrievalPolicy: {
      hardFilters: policy.hardFilters,
      softBoosts: policy.softBoosts,
      softBoostKeys: policy.softBoostKeys,
      ignoredFacets: policy.ignored,
      topKDense: topK.topKDense,
      topKSparse: topK.topKSparse,
      finalTopK: topK.finalTopK,
      semanticTopK: topK.semanticTopK,
      // Rank-based selection only — no absolute RRF score gate
      useScoreThreshold: false,
      allowRelax: true,
      useKeywordScroll: false,
      contextMode,
      tokenBudget,
      minResults: Math.min(5, topK.finalTopK),
    },
  };

  return plan;
}

/**
 * Rank-based selection: sort by reranked score, take finalTopK.
 * Never filters on absolute RRF/hybrid scores (they are not cosine).
 */
function selectMatchesByPlan(matches, plan, { relaxed = false } = {}) {
  if (!matches?.length) return [];

  const policy = plan?.retrievalPolicy || {};
  const sorted = [...matches].sort(
    (a, b) => (b.score || 0) - (a.score || 0),
  );

  let finalTopK = policy.finalTopK || 15;
  if (relaxed) {
    finalTopK = Math.min(
      sorted.length,
      Math.max(finalTopK, policy.minResults || 5) + 5,
    );
  }

  return sorted.slice(0, Math.max(finalTopK, 12));
}

function logRetrievalPlan(plan) {
  if (!plan) return;
  const facetStr = (plan.facets || [])
    .map((f) => `${f.key}:${f.value}@${f.confidence}`)
    .join(", ");
  console.log(
    `[RetrievalPlan] intent=${plan.intent} subIntent=${plan.subIntent || "none"} ` +
      `context=${plan.retrievalPolicy?.contextMode} ` +
      `facets=[${facetStr}] lexical=${(plan.lexicalTerms || []).length} ` +
      `hardFilters=${(plan.retrievalPolicy?.hardFilters || []).length} ` +
      `softBoosts=${(plan.retrievalPolicy?.softBoosts || []).length} ` +
      `candidates=${plan.retrievalPolicy?.semanticTopK} final=${plan.retrievalPolicy?.finalTopK}`,
  );
}

module.exports = {
  buildRetrievalPlan,
  selectMatchesByPlan,
  logRetrievalPlan,
  buildHeuristicFacets,
  buildLexicalTerms,
  mapTargetPageTypesToFacets,
  // Re-exported for backward compatibility with any existing callers/tests
  // that referenced the old defaults directly from this module.
  HARD_FILTER_KEYS: DEFAULT_HARD_FILTER_KEYS,
  HIGH_CONFIDENCE: DEFAULT_HARD_FILTER_MIN_CONFIDENCE,
};
