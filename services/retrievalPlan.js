/**
 * Intent-driven Retrieval Plan.
 * Facets are soft signals for rerank/sparse — not hard Qdrant filters
 * (except tenant isolation and rare high-confidence indexed ids).
 *
 * Industry pattern: retrieve deep → multi-signal rerank → take top-N by rank.
 * RRF fusion scores are rank-based — never gate on absolute thresholds.
 */

const HARD_FILTER_KEYS = new Set(["product_id", "sku"]);
const HIGH_CONFIDENCE = 0.9;

/**
 * @typedef {Object} Facet
 * @property {string} key
 * @property {string} value
 * @property {number} confidence
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
 * Build facets from queryAttributes (sizes/collections stay as soft facets only).
 */
function buildFacets(queryAttributes = {}) {
  const facets = [];

  for (const size of queryAttributes.sizes || []) {
    const value = normalizeFacetValue(size);
    if (!value) continue;
    facets.push({ key: "size", value, confidence: 0.85 });
  }

  for (const collection of queryAttributes.collections || []) {
    const value = normalizeFacetValue(collection);
    if (!value) continue;
    facets.push({ key: "collection", value, confidence: 0.75 });
  }

  if (queryAttributes.subIntent === "IN_PAGE_LIST") {
    facets.push({ key: "intent_signal", value: "price", confidence: 0.7 });
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
 * Hard filters only for high-confidence indexed identity facets.
 * Size/collection never become hard Qdrant filters.
 */
function buildHardFilters(facets = []) {
  return facets.filter(
    (f) =>
      HARD_FILTER_KEYS.has(f.key) &&
      typeof f.confidence === "number" &&
      f.confidence >= HIGH_CONFIDENCE &&
      f.value,
  );
}

/**
 * @param {object} params
 * @param {object} params.routing - from routeQuery
 * @param {object} params.queryAttributes - from extractQueryAttributes
 * @param {number} [params.requestedTopK]
 */
function buildRetrievalPlan({
  routing = {},
  queryAttributes = {},
  requestedTopK = 10,
} = {}) {
  const intent = routing.route || queryAttributes.route || "SEMANTIC_RAG";
  const subIntent =
    queryAttributes.subIntent || routing.subIntent || null;

  const facets = buildFacets(queryAttributes);
  const lexicalTerms = buildLexicalTerms(queryAttributes, facets, routing);
  const contextMode = resolveContextMode(subIntent);
  const tokenBudget = resolveTokenBudget(contextMode);
  const topK = resolveTopK(subIntent, requestedTopK);
  const hardFilters = buildHardFilters(facets);

  const softBoostKeys = [
    ...new Set(
      facets
        .filter((f) => !HARD_FILTER_KEYS.has(f.key))
        .map((f) => f.key),
    ),
  ];

  /** @type {RetrievalPlan} */
  const plan = {
    intent,
    subIntent,
    facets,
    lexicalTerms,
    queryAttributes,
    retrievalPolicy: {
      hardFilters,
      softBoostKeys,
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
      `candidates=${plan.retrievalPolicy?.semanticTopK} final=${plan.retrievalPolicy?.finalTopK}`,
  );
}

module.exports = {
  buildRetrievalPlan,
  selectMatchesByPlan,
  logRetrievalPlan,
  buildFacets,
  buildLexicalTerms,
  HARD_FILTER_KEYS,
  HIGH_CONFIDENCE,
};
