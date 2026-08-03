/**
 * Unified entity / attribute extraction for the retrieval pipeline.
 * Consolidates sizes, collections, keywords, and intent flags from
 * normalization, context expansion, and routing.
 */

const {
  buildRetrievalKeywords,
  extractSizeTokens,
} = require("./queryNormalization");
const { extractCollectionHints } = require("./queryContextExpansion");
const { ROUTES, isRagRoute } = require("../services/QueryRouter");

const RETRIEVAL_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "all",
  "show",
  "list",
  "give",
  "me",
  "how",
  "your",
  "our",
  "my",
  "what",
  "when",
  "where",
  "have",
  "get",
  "can",
  "could",
  "would",
  "will",
  "that",
  "this",
  "from",
  "about",
  "only",
  "just",
  "please",
  "there",
  "their",
]);

function tokenizeKeywords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !RETRIEVAL_STOP_WORDS.has(w));
}

/**
 * @param {object} params
 * @param {string} params.normalizedQuestion
 * @param {object} params.queryNorm - from normalizeUserQuery()
 * @param {object} params.queryExpansion - from expandQueryForRetrieval()
 * @param {object} [params.routing] - from routeQuery()
 * @param {string} [params.subIntent] - effective subIntent after post-routing heuristics
 */
function extractQueryAttributes({
  normalizedQuestion,
  queryNorm,
  queryExpansion,
  routing = {},
  subIntent = null,
}) {
  const {
    retrievalQuery = normalizedQuestion,
    currentSizes = [],
    topics = {},
  } = queryExpansion || {};

  const keywordSource = routing.rewrittenQuery || retrievalQuery;

  const sizes = [
    ...new Set([
      ...(queryNorm?.sizes || []),
      ...(currentSizes || []),
      ...(topics.sizes || []),
      ...extractSizeTokens(keywordSource),
    ]),
  ];

  const collections = [
    ...new Set([
      ...extractCollectionHints(keywordSource),
      ...(topics.collections || []),
    ]),
  ];

  const morphologyHints = queryNorm?.morphologyHints || [];
  const sizeKeywords = sizes.flatMap((s) => {
    const compact = s.replace(/\s/g, "");
    const numOnly = compact.replace(/mm$/i, "");
    return [compact, numOnly].filter((k) => k.length > 2);
  });

  const routerTerms = (routing.lexicalTerms || [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t.length > 1);

  console.log("extractQueryAttributes check at routing : ", routerTerms);

  console.log(
    "build RetrievalKeywords check at query : ",
    buildRetrievalKeywords(keywordSource, sizes),
  );

  console.log("sized keywords check at query : ", sizeKeywords);

  console.log("morphology hints check at query : ", morphologyHints);

  
  const keywords = [
    ...new Set([
      ...routerTerms,
      ...tokenizeKeywords(keywordSource),
      // ...buildRetrievalKeywords(keywordSource, sizes),
      ...(queryNorm?.retrievalKeywords || []),
      // ...sizeKeywords,
      ...morphologyHints,
      ...collections.map((c) => c.toLowerCase()),
    ]),
  ].filter((k) => k.length > 2);

  console.log("extractQueryAttributes check at query : ", keywords);

  return {
    normalizedQuestion,
    retrievalQuery,
    keywordSource,
    embeddingQuery: queryNorm?.enrichForEmbedding
      ? queryNorm.enrichForEmbedding(keywordSource)
      : keywordSource,
    sizes,
    collections,
    keywords,
    route: routing.route || ROUTES.SEMANTIC_RAG,
    subIntent,
    userLanguage: routing.userLanguage || "en",
  };
}

function needsKeywordRetrieval(attributes) {
  if (!attributes) return false;
  const { subIntent, sizes } = attributes;
  return (
    subIntent === "IN_PAGE_LIST" ||
    subIntent === "PAGE_LINKS" ||
    subIntent === "CONTACT_INFO" ||
    sizes.length > 0
  );
}

/**
 * @deprecated Prefer RetrievalPlan contextMode === "list".
 * Kept for backward compatibility; no longer used as a hard filter gate.
 */
function isExplicitSizedCatalogQuery(question, queryAttributes) {
  const sizes = queryAttributes?.sizes || [];
  if (sizes.length === 0) return false;

  const q = (question || "").toLowerCase();
  const hasProductWord =
    /\b(lash|lashes|product|style|collection|catalog)\b/i.test(q);
  const hasListIntent =
    /\b(all|every|each|list|show|give\s+me|what\s+are)\b/i.test(q) ||
    queryAttributes?.subIntent === "IN_PAGE_LIST";

  return hasProductWord && hasListIntent;
}

module.exports = {
  extractQueryAttributes,
  isRagRoute,
  needsKeywordRetrieval,
  isExplicitSizedCatalogQuery,
};
