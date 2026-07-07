/**
 * Determine retrieval intent and target doc_types.
 * Router subIntent is authoritative; keyword patterns are fallback only.
 */

const { DOC_TYPE, SEARCH_INTENT } = require("../constants/contentTypes");
const {
  getIntentBehavior,
  ALL_DOC_TYPES,
  SUB_INTENT,
} = require("./intentMapping");
const { isEcommerceCatalogQuery } = require("./queryContextExpansion");

function isSizedCatalogQuery(question, queryAttributes = {}) {
  if (queryAttributes.subIntent === SUB_INTENT.IN_PAGE_LIST) {
    return (queryAttributes.sizes || []).length > 0;
  }

  const sizes = queryAttributes.sizes || [];
  if (sizes.length === 0) return false;

  const q = (question || "").toLowerCase();
  const hasProductWord =
    /\b(lash|lashes|product|style|collection|catalog)\b/i.test(q);
  const hasListIntent =
    /\b(all|every|each|list|show|give\s+me|what\s+are)\b/i.test(q) ||
    queryAttributes.flags?.isCatalogQuery;

  return hasProductWord && hasListIntent;
}

const KNOWLEDGE_PATTERNS = [
  /\b(return|refund|shipping|policy|policies|privacy|terms|warranty|cancel)\b/i,
  /\b(hours?|contact|email|phone|address)\b/i,
  /\b(how\s+(?:do|can|to)|what\s+is\s+your)\b/i,
  /\bsocial\s*media\b/i,
  /\b(facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest)\b/i,
];

const CATEGORY_PATTERNS = [
  /\b(collections?|categories|catalog|browse|shop\s+all)\b/i,
  /\bwhat\s+(?:collections?|categories)\b/i,
  /\bshow\s+(?:me\s+)?(?:all\s+)?(?:collections?|categories)\b/i,
];

function buildCanonicalQuery(question, queryAttributes = {}) {
  const sizes = queryAttributes.sizes || [];
  const base = (question || "").trim().replace(/\s+/g, " ");
  const sizePart = sizes.length > 0 ? ` ${sizes.join(" ")}` : "";
  return `${base}${sizePart}`.replace(/\b(lashes|lash)\b/gi, "lash").trim();
}

/**
 * Keyword-only fallback when router subIntent is null.
 */
function resolveRetrievalIntentFromKeywords(question, queryAttributes = {}) {
  const q = (question || "").toLowerCase();
  const sizes = queryAttributes.sizes || [];
  const isSizedCatalog = isSizedCatalogQuery(question, queryAttributes);
  const isCatalog = isEcommerceCatalogQuery(question);

  const hasKnowledgeSignal = KNOWLEDGE_PATTERNS.some((p) => p.test(q));
  const hasCategorySignal = CATEGORY_PATTERNS.some((p) => p.test(q));
  const hasEntitySignal =
    isSizedCatalog ||
    isCatalog ||
    /\b(lash|lashes|product|item|style|sku|variant|price|cost)\b/i.test(q);

  if (hasKnowledgeSignal && (hasEntitySignal || hasCategorySignal)) {
    return {
      intent: SEARCH_INTENT.MIXED,
      docTypes: [DOC_TYPE.ENTITY, DOC_TYPE.KNOWLEDGE],
      strictEntity: isSizedCatalog,
      filterStructuralByDocType: true,
      canonicalQuery: buildCanonicalQuery(question, queryAttributes),
    };
  }

  if (hasKnowledgeSignal && !hasEntitySignal) {
    return {
      intent: SEARCH_INTENT.KNOWLEDGE,
      docTypes: [DOC_TYPE.KNOWLEDGE],
      strictEntity: false,
      filterStructuralByDocType: false,
      canonicalQuery: buildCanonicalQuery(question, queryAttributes),
    };
  }

  if (hasCategorySignal && !isSizedCatalog && sizes.length === 0) {
    return {
      intent: SEARCH_INTENT.CATEGORY,
      docTypes: [DOC_TYPE.CATEGORY, DOC_TYPE.ENTITY],
      strictEntity: false,
      filterStructuralByDocType: true,
      canonicalQuery: buildCanonicalQuery(question, queryAttributes),
    };
  }

  if (hasEntitySignal || sizes.length > 0) {
    return {
      intent: SEARCH_INTENT.ENTITY,
      docTypes: [DOC_TYPE.ENTITY],
      strictEntity: isSizedCatalog || sizes.length > 0,
      filterStructuralByDocType: true,
      canonicalQuery: buildCanonicalQuery(question, queryAttributes),
    };
  }

  return {
    intent: SEARCH_INTENT.MIXED,
    docTypes: ALL_DOC_TYPES,
    strictEntity: false,
    filterStructuralByDocType: false,
    canonicalQuery: buildCanonicalQuery(question, queryAttributes),
  };
}

/**
 * @param {string} question
 * @param {object} [queryAttributes]
 */
function resolveRetrievalIntent(question, queryAttributes = {}) {
  const subIntent = queryAttributes.subIntent || null;
  const behavior = getIntentBehavior(subIntent, {
    sizes: queryAttributes.sizes,
  });

  if (behavior) {
    return {
      intent: behavior.retrievalIntent,
      docTypes: behavior.docTypes,
      strictEntity: behavior.strictEntitySearch,
      filterStructuralByDocType: behavior.filterStructuralByDocType,
      canonicalQuery: buildCanonicalQuery(question, queryAttributes),
    };
  }

  return resolveRetrievalIntentFromKeywords(question, queryAttributes);
}

module.exports = {
  resolveRetrievalIntent,
  buildCanonicalQuery,
  isSizedCatalogQuery,
};
