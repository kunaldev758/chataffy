/**
 * Rule-based retrieval strategy builder (no LLM).
 * Maps route / subIntent / query attributes → hard filters + soft boosts.
 */

const { ROUTES } = require("../QueryRouter");

/**
 * @typedef {Object} RetrievalStrategy
 * @property {string} mode - semantic | hybrid | catalog_list | page_links | contact
 * @property {string[]} preferredEntityTypes - hard filter when non-empty (first pass)
 * @property {string[]} softEntityTypes - soft boost types
 * @property {string[]} preferredPageTypes
 * @property {object} attributeHardFilters - e.g. { sizes: string[] }
 * @property {number} topK
 * @property {boolean} useKeyword
 * @property {boolean} hardFilterEntity - apply entity_type as Qdrant must
 * @property {boolean} hardFilterAttributes - apply attribute constraints as must
 * @property {string} reason
 */

function buildRetrievalStrategy({
  route = ROUTES.SEMANTIC_RAG,
  subIntent = null,
  queryAttributes = {},
  requestedTopK = 8,
} = {}) {
  const flags = queryAttributes.flags || {};
  const sizes = queryAttributes.sizes || [];
  const q = String(
    queryAttributes.normalizedQuestion || queryAttributes.retrievalQuery || "",
  ).toLowerCase();

  /** @type {RetrievalStrategy} */
  const strategy = {
    mode: "hybrid",
    preferredEntityTypes: [],
    softEntityTypes: [],
    preferredPageTypes: [],
    attributeHardFilters: {},
    topK: requestedTopK,
    useKeyword: true,
    hardFilterEntity: false,
    hardFilterAttributes: false,
    reason: "default_hybrid",
  };

  // --- Structural / specialized modes ---
  if (subIntent === "IN_PAGE_LIST" || flags.isCatalogQuery) {
    strategy.mode = "catalog_list";
    strategy.preferredEntityTypes = ["listing", "product"];
    strategy.softEntityTypes = ["listing", "product"];
    strategy.preferredPageTypes = ["product"];
    strategy.hardFilterEntity = true;
    strategy.topK = Math.max(requestedTopK, 15);
    strategy.reason = "catalog_list";
    if (sizes.length) {
      strategy.attributeHardFilters.sizes = sizes;
      strategy.hardFilterAttributes = false; // sizes often only in text; soft first
    }
    return strategy;
  }

  if (subIntent === "PAGE_LINKS" || flags.wantsProductLinks) {
    strategy.mode = "page_links";
    strategy.preferredEntityTypes = ["listing", "product", "general"];
    strategy.softEntityTypes = ["listing", "product"];
    strategy.hardFilterEntity = false;
    strategy.topK = Math.max(requestedTopK, 12);
    strategy.reason = "page_links";
    return strategy;
  }

  if (subIntent === "CONTACT_INFO" || flags.wantsContact) {
    strategy.mode = "contact";
    strategy.preferredEntityTypes = ["about", "general"];
    strategy.softEntityTypes = ["about", "general", "policy"];
    strategy.hardFilterEntity = false;
    strategy.topK = Math.max(requestedTopK, 12);
    strategy.reason = "contact_info";
    return strategy;
  }

  // --- Semantic / hybrid by question shape ---
  const wantsFaq =
    /\b(faq|frequently asked|how (do|can|to)|shipping|return|refund|warranty)\b/i.test(
      q,
    );
  const wantsReview = /\b(review|reviews|rating|ratings|testimonial)\b/i.test(q);
  const wantsPolicy =
    /\b(privacy|terms|policy|policies|legal|gdpr)\b/i.test(q);
  const wantsProduct =
    flags.wantsPrices ||
    /\b(price|buy|sku|in stock|product|shoe|size|color|colour)\b/i.test(q) ||
    sizes.length > 0;

  if (wantsFaq) {
    strategy.preferredEntityTypes = ["faq", "policy", "product"];
    strategy.softEntityTypes = ["faq", "policy", "product"];
    strategy.preferredPageTypes = ["faq", "product", "generic"];
    strategy.hardFilterEntity = true;
    strategy.reason = "faq_policy_intent";
  } else if (wantsReview) {
    strategy.preferredEntityTypes = ["review", "product"];
    strategy.softEntityTypes = ["review", "product"];
    strategy.hardFilterEntity = true;
    strategy.reason = "review_intent";
  } else if (wantsPolicy) {
    strategy.preferredEntityTypes = ["policy", "faq"];
    strategy.softEntityTypes = ["policy", "faq"];
    strategy.hardFilterEntity = true;
    strategy.reason = "policy_intent";
  } else if (wantsProduct) {
    strategy.preferredEntityTypes = ["product", "listing"];
    strategy.softEntityTypes = ["product", "listing", "faq"];
    strategy.preferredPageTypes = ["product"];
    strategy.hardFilterEntity = true;
    strategy.reason = "product_intent";
    if (sizes.length) {
      strategy.attributeHardFilters.sizes = sizes;
    }
  } else if (route === ROUTES.HYBRID) {
    strategy.reason = "hybrid_route";
    strategy.softEntityTypes = ["product", "listing", "faq", "general"];
  } else {
    strategy.mode = "semantic";
    strategy.reason = "semantic_default";
    strategy.softEntityTypes = [
      "product",
      "listing",
      "faq",
      "docs",
      "blog_post",
      "general",
    ];
  }

  strategy.topK = Math.max(strategy.topK, requestedTopK);
  return strategy;
}

/**
 * Broaden strategy for one retry: drop hard entity/attribute filters, keep soft boosts.
 */
function broadenRetrievalStrategy(strategy = {}) {
  return {
    ...strategy,
    hardFilterEntity: false,
    hardFilterAttributes: false,
    preferredEntityTypes: [],
    softEntityTypes:
      strategy.softEntityTypes?.length > 0
        ? strategy.softEntityTypes
        : ["product", "listing", "faq", "general", "policy", "review"],
    topK: Math.min(40, Math.max((strategy.topK || 8) * 2, 16)),
    reason: `${strategy.reason || "default"}+broadened`,
    broadened: true,
  };
}

module.exports = {
  buildRetrievalStrategy,
  broadenRetrievalStrategy,
};
