/**
 * Unified entity / attribute extraction for the retrieval pipeline.
 * Consolidates sizes, collections, keywords, and intent flags from
 * normalization, context expansion, and routing.
 */

const {
  buildRetrievalKeywords,
  extractSizeTokens,
} = require("./queryNormalization");
const {
  extractCollectionHints,
} = require("./queryContextExpansion");
const { ROUTES, isRagRoute } = require("../services/QueryRouter");

const RETRIEVAL_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with",
  "all", "show", "list", "give", "me", "how", "your", "our", "my", "what",
  "when", "where", "have", "get", "can", "could", "would", "will", "that",
  "this", "from", "about", "only", "just", "please", "there", "their",
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
    wantsProductLinks = false,
    isCatalogQuery = false,
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
      ...extractCollectionHints(normalizedQuestion),
      ...extractCollectionHints(retrievalQuery),
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

  const keywords = [
    ...new Set([
      ...tokenizeKeywords(keywordSource),
      ...buildRetrievalKeywords(keywordSource, sizes),
      ...(queryNorm?.retrievalKeywords || []),
      ...sizeKeywords,
      ...morphologyHints,
      ...collections.map((c) => c.toLowerCase()),
    ]),
  ].filter((k) => k.length > 2);

  const q = (normalizedQuestion || "").toLowerCase();
  const wantsHomepage =
    /\b(homepage|home\s*page|main\s*page|featured)\b/i.test(q);
  const wantsContact =
    subIntent === "CONTACT_INFO" ||
    /\b(social\s*media|phone|email|address|hours|contact)\b/i.test(q);
  const wantsPrices =
    /\b(price|prices|cost|pricing|how\s+much)\b/i.test(q);

  const priceRange = extractPriceRange(q);

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
    priceRange,
    flags: {
      wantsProductLinks,
      isCatalogQuery,
      wantsHomepage,
      wantsContact,
      wantsPrices,
      wasExpanded: queryExpansion?.wasExpanded || false,
    },
  };
}

function needsKeywordRetrieval(attributes) {
  if (!attributes) return false;
  const { flags, sizes, keywords } = attributes;
  return (
    flags?.isCatalogQuery ||
    flags?.wasExpanded ||
    sizes.length > 0 ||
    flags?.wantsProductLinks ||
    (keywords?.length > 0 && flags?.wantsHomepage)
  );
}

/**
 * Explicit sized catalog request, e.g. "give me all 16mm lashes".
 */
function isExplicitSizedCatalogQuery(question, queryAttributes) {
  const sizes = queryAttributes?.sizes || [];
  if (sizes.length === 0) return false;

  const q = (question || "").toLowerCase();
  const hasProductWord =
    /\b(lash|lashes|product|style|collection|catalog)\b/i.test(q);
  const hasListIntent =
    /\b(all|every|each|list|show|give\s+me|what\s+are)\b/i.test(q) ||
    queryAttributes?.subIntent === "IN_PAGE_LIST" ||
    queryAttributes?.flags?.isCatalogQuery;

  return hasProductWord && hasListIntent;
}

function extractPriceRange(text) {
  const q = (text || "").toLowerCase();
  let maxPrice = null;
  let minPrice = null;

  // 1. Between $X and $Y
  const betweenMatch = q.match(/\b(?:between|from)\s+\$?\s*(\d+(?:\.\d+)?)\s+(?:and|to)\s+\$?\s*(\d+(?:\.\d+)?)\b/);
  if (betweenMatch) {
    minPrice = parseFloat(betweenMatch[1]);
    maxPrice = parseFloat(betweenMatch[2]);
    return { minPrice, maxPrice };
  }

  // 2. Under $X
  const underMatch = q.match(/\b(?:under|less\s+than|cheaper\s+than|max|maximum|below|<)\s+\$?\s*(\d+(?:\.\d+)?)\b/);
  if (underMatch) {
    maxPrice = parseFloat(underMatch[1]);
    return { minPrice, maxPrice };
  }

  // 3. Over $X
  const overMatch = q.match(/\b(?:over|more\s+than|above|min|minimum|greater\s+than|>)\s+\$?\s*(\d+(?:\.\d+)?)\b/);
  if (overMatch) {
    minPrice = parseFloat(overMatch[1]);
    return { minPrice, maxPrice };
  }

  return null;
}

module.exports = {
  extractQueryAttributes,
  isRagRoute,
  needsKeywordRetrieval,
  isExplicitSizedCatalogQuery,
  extractPriceRange,
};
