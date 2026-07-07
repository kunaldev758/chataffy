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
const { resolveRetrievalIntent } = require("./retrievalIntent");
const {
  getIntentBehavior,
  resolveResponseMode,
} = require("./intentMapping");
const { ROUTES, isRagRoute } = require("../services/QueryRouter");
const { isContactIntentQuestion } = require("./contactIntentDetection");

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

function buildKeywordFlags(question, queryExpansion) {
  const q = (question || "").toLowerCase();
  return {
    wantsProductLinks: queryExpansion?.wantsProductLinks || false,
    isCatalogQuery: queryExpansion?.isCatalogQuery || false,
    wantsHomepage: /\b(homepage|home\s*page|main\s*page|featured)\b/i.test(q),
    wantsContact:
      isContactIntentQuestion(question) ||
      /\b(social\s*media|phone|email|address|hours|contact)\b/i.test(q),
    wantsPrices: /\b(price|prices|cost|pricing|how\s+much)\b/i.test(q),
    wasExpanded: queryExpansion?.wasExpanded || false,
  };
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

  const intentBehavior = getIntentBehavior(subIntent, { sizes });
  const keywordFlags = buildKeywordFlags(normalizedQuestion, queryExpansion);
  const flags = intentBehavior?.flags
    ? { ...intentBehavior.flags, wasExpanded: keywordFlags.wasExpanded }
    : keywordFlags;

  const partial = {
    normalizedQuestion,
    retrievalQuery,
    keywordSource,
    embeddingQuery: queryNorm?.enrichForEmbedding
      ? queryNorm.enrichForEmbedding(retrievalQuery)
      : retrievalQuery,
    sizes,
    collections,
    keywords,
    route: routing.route || ROUTES.SEMANTIC_RAG,
    subIntent,
    userLanguage: routing.userLanguage || "en",
    flags,
  };

  const retrieval = resolveRetrievalIntent(normalizedQuestion, partial);

  return {
    ...partial,
    retrievalIntent: retrieval.intent,
    docTypes: retrieval.docTypes,
    strictEntitySearch: retrieval.strictEntity,
    filterStructuralByDocType: retrieval.filterStructuralByDocType,
    canonicalQuery: retrieval.canonicalQuery,
    responseMode: resolveResponseMode(subIntent, partial),
  };
}

function needsKeywordRetrieval(attributes) {
  if (!attributes) return false;
  const { flags, sizes, keywords, subIntent } = attributes;
  return (
    subIntent === "CONTACT_INFO" ||
    subIntent === "PAGE_LINKS" ||
    flags?.isCatalogQuery ||
    flags?.wasExpanded ||
    flags?.wantsContact ||
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

  if (queryAttributes?.subIntent === "IN_PAGE_LIST") {
    return /\b(lash|lashes|product|style|collection|catalog)\b/i.test(
      (question || "").toLowerCase(),
    );
  }

  const q = (question || "").toLowerCase();
  const hasProductWord =
    /\b(lash|lashes|product|style|collection|catalog)\b/i.test(q);
  const hasListIntent =
    /\b(all|every|each|list|show|give\s+me|what\s+are)\b/i.test(q) ||
    queryAttributes?.flags?.isCatalogQuery;

  return hasProductWord && hasListIntent;
}

module.exports = {
  extractQueryAttributes,
  isRagRoute,
  needsKeywordRetrieval,
  isExplicitSizedCatalogQuery,
};
