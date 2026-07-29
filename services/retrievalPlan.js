/**
 * Intent-driven Retrieval Plan.
 * Facets are soft signals for rerank/sparse — not hard Qdrant filters
 * (except tenant isolation and rare high-confidence indexed ids).
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
  return "parent_chunks";
}

function resolveTokenBudget(contextMode) {
  switch (contextMode) {
    case "list":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_LIST) || 3000;
    case "links":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_LINKS) || 3000;
    case "contact":
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
    default:
      return Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
  }
}

function resolveTopK(subIntent, requestedTopK = 10) {
  if (subIntent === "IN_PAGE_LIST") {
    return {
      topKDense: 30,
      topKSparse: 30,
      finalTopK: Math.max(15, Math.min(20, requestedTopK * 2)),
      semanticTopK: Math.max(15, Math.min(30, requestedTopK * 3)),
    };
  }
  if (subIntent === "CONTACT_INFO") {
    return {
      topKDense: 20,
      topKSparse: 20,
      finalTopK: 12,
      semanticTopK: 12,
    };
  }
  if (subIntent === "PAGE_LINKS") {
    return {
      topKDense: 24,
      topKSparse: 24,
      finalTopK: Math.max(12, requestedTopK * 2),
      semanticTopK: Math.max(12, requestedTopK * 2),
    };
  }
  return {
    topKDense: 30,
    topKSparse: 30,
    finalTopK: Math.max(15, requestedTopK),
    semanticTopK: Math.max(10, requestedTopK),
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
 * @param {number} [params.scoreThreshold]
 */
function buildRetrievalPlan({
  routing = {},
  queryAttributes = {},
  requestedTopK = 10,
  scoreThreshold = 0.4,
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


  console.log("check facets :",facets);

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
      allowRelax: true,
      // Keyword payload scroll is optional legacy assist; sparse RRF is primary lexical path
      useKeywordScroll: false,
      contextMode,
      tokenBudget,
      scoreThreshold,
      minResults: Math.min(5, topK.finalTopK),
      relaxThresholdDelta: 0.15,
      minScoreFloor: 0.2,
    },
  };

  return plan;
}

/**
 * Select matches using plan policy (score threshold + optional soft facet preference).
 * Never hard-filters by size.
 */
function selectMatchesByPlan(matches, plan, { relaxed = false } = {}) {
  if (!matches?.length) return [];

  const policy = plan?.retrievalPolicy || {};
  let threshold = policy.scoreThreshold ?? 0.4;
  if (relaxed) {
    threshold = Math.max(
      policy.minScoreFloor ?? 0.2,
      threshold - (policy.relaxThresholdDelta ?? 0.15),
    );
  }

  const isList = policy.contextMode === "list";
  // List intents: keep more candidates; still no hard size gate
  const filtered = isList
    ? [...matches].sort((a, b) => (b.score || 0) - (a.score || 0))
    : matches.filter((m) => (m.score ?? 0) >= threshold);

  const finalTopK = policy.finalTopK || 15;
  return filtered.slice(0, Math.max(finalTopK, 15));
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
      `topK=${plan.retrievalPolicy?.semanticTopK}/${plan.retrievalPolicy?.finalTopK}`,
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
