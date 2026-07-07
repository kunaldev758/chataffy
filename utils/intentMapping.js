/**
 * Maps router subIntent → retrieval, flags, and response behavior.
 * Single source of truth after QueryRouter; keyword heuristics are fallback only.
 */

const { DOC_TYPE, SEARCH_INTENT } = require("../constants/contentTypes");

const SUB_INTENT = {
  IN_PAGE_LIST: "IN_PAGE_LIST",
  CONTACT_INFO: "CONTACT_INFO",
  PAGE_LINKS: "PAGE_LINKS",
};

const ALL_DOC_TYPES = [
  DOC_TYPE.ENTITY,
  DOC_TYPE.CATEGORY,
  DOC_TYPE.KNOWLEDGE,
];

/**
 * @param {string|null} subIntent
 * @param {{ sizes?: string[] }} [options]
 */
function getIntentBehavior(subIntent, options = {}) {
  const sizes = options.sizes || [];

  switch (subIntent) {
    case SUB_INTENT.CONTACT_INFO:
      return {
        retrievalIntent: SEARCH_INTENT.KNOWLEDGE,
        docTypes: [DOC_TYPE.KNOWLEDGE],
        strictEntitySearch: false,
        filterStructuralByDocType: false,
        responseMode: "contact",
        flags: {
          wantsProductLinks: false,
          isCatalogQuery: false,
          wantsContact: true,
          wantsHomepage: false,
          wantsPrices: false,
        },
      };

    case SUB_INTENT.IN_PAGE_LIST:
      return {
        retrievalIntent: SEARCH_INTENT.ENTITY,
        docTypes: [DOC_TYPE.ENTITY],
        strictEntitySearch: sizes.length > 0,
        filterStructuralByDocType: true,
        responseMode: "list",
        flags: {
          wantsProductLinks: false,
          isCatalogQuery: true,
          wantsContact: false,
          wantsHomepage: false,
          wantsPrices: false,
        },
      };

    case SUB_INTENT.PAGE_LINKS:
      return {
        retrievalIntent: SEARCH_INTENT.CATEGORY,
        docTypes: [DOC_TYPE.CATEGORY, DOC_TYPE.KNOWLEDGE],
        strictEntitySearch: false,
        filterStructuralByDocType: true,
        responseMode: "page_links",
        flags: {
          wantsProductLinks: true,
          isCatalogQuery: false,
          wantsContact: false,
          wantsHomepage: false,
          wantsPrices: false,
        },
      };

    default:
      return null;
  }
}

/**
 * Infer subIntent from keywords only when router did not set one.
 * @param {string} question
 * @param {{ sizes?: string[], hasSizeFilter?: boolean }} [options]
 */
function inferSubIntentFromQuestion(question, options = {}) {
  const { isContactIntentQuestion, isPrimarilyContactQuestion } = require("./contactIntentDetection");
  const {
    isProductLinkRequest,
    isEcommerceCatalogQuery,
  } = require("./queryContextExpansion");

  const q = (question || "").toLowerCase();
  const sizes = options.sizes || [];

  if (isPrimarilyContactQuestion(question) || isContactIntentQuestion(question)) {
    return SUB_INTENT.CONTACT_INFO;
  }

  const hasSizeFilter =
    options.hasSizeFilter ??
    (sizes.length > 0 &&
      /\b(lash|lashes|product|style|collection)\b/i.test(q));

  if (hasSizeFilter || (isEcommerceCatalogQuery(question) && sizes.length > 0)) {
    return SUB_INTENT.IN_PAGE_LIST;
  }

  if (isProductLinkRequest(question)) {
    return /\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(q)
      ? SUB_INTENT.IN_PAGE_LIST
      : SUB_INTENT.PAGE_LINKS;
  }

  if (
    isEcommerceCatalogQuery(question) &&
    /\b(list|show|give\s+me|what\s+are)\b/i.test(q)
  ) {
    return SUB_INTENT.IN_PAGE_LIST;
  }

  return null;
}

function resolveResponseMode(subIntent, queryAttributes = {}) {
  const fromIntent = getIntentBehavior(subIntent, {
    sizes: queryAttributes.sizes,
  });
  if (fromIntent?.responseMode) return fromIntent.responseMode;

  if ((queryAttributes.sizes || []).length > 0) return "list";
  if (queryAttributes.flags?.wantsContact) return "contact";
  if (queryAttributes.flags?.wantsProductLinks) return "page_links";
  if (queryAttributes.flags?.isCatalogQuery) return "list";
  return "brief";
}

module.exports = {
  SUB_INTENT,
  ALL_DOC_TYPES,
  getIntentBehavior,
  inferSubIntentFromQuestion,
  resolveResponseMode,
};
