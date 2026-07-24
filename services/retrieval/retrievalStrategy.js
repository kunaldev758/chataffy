/**
 * Rule-based retrieval strategy builder (no LLM).
 * Maps route / subIntent / query attributes → hard filters + soft boosts.
 *
 * Critical split when pageType=product:
 *   entity_type=product  → PDP (single product)
 *   entity_type=listing  → PLP (collection / catalog grid)
 */

const { ROUTES } = require("../QueryRouter");

/**
 * @typedef {Object} RetrievalStrategy
 * @property {string} mode - semantic | hybrid | catalog_list | page_links | contact | product_detail
 * @property {string[]} preferredEntityTypes - ordered; 1st gets strongest boost / hard filter
 * @property {string[]} softEntityTypes - soft boost types (not hard-filtered)
 * @property {string[]} preferredPageTypes
 * @property {object} attributeHardFilters - e.g. { sizes: string[] }
 * @property {number} topK
 * @property {boolean} useKeyword
 * @property {boolean} hardFilterEntity - apply preferredEntityTypes as Qdrant must
 * @property {boolean} hardFilterAttributes
 * @property {string} primaryEntity - product | listing | null
 * @property {string} reason
 */

/** Browse / list-all signals → prefer listing (PLP). */
function isCatalogBrowseIntent(q, flags = {}) {
  if (flags.isCatalogQuery) return true;
  return (
    /\b(all|every|entire|full)\s+(products?|items?|shoes?|collection|catalog)\b/i.test(
      q,
    ) ||
    /\b(show|list|browse|see)\s+(me\s+)?(all|every|the)?\s*(products?|items?|shoes?|options?|collection)\b/i.test(
      q,
    ) ||
    /\b(what\s+products|which\s+products|products?\s+do\s+you\s+(have|sell)|catalog|collection)\b/i.test(
      q,
    ) ||
    /\b(available\s+products?|product\s+list|shop\s+all)\b/i.test(q)
  );
}

/**
 * Specific product / PDP signals → prefer product only.
 * Named-ish queries, price, SKU, buy, stock, color/size of a thing.
 */
function isSpecificProductIntent(q, flags = {}, sizes = []) {
  if (flags.wantsPrices) return true;
  if (
    /\b(price|pricing|cost|how\s+much|sku|buy\s+now|add\s+to\s+cart|in\s+stock|out\s+of\s+stock)\b/i.test(
      q,
    )
  ) {
    return true;
  }
  // "tell me about X", "details of X", "is X available"
  if (
    /\b(tell\s+me\s+about|details?\s+(of|for|on)|specs?\s+(of|for)|information\s+(on|about))\b/i.test(
      q,
    )
  ) {
    return true;
  }
  // Size/color usually refer to a specific product when not a full catalog ask
  if (
    (sizes.length > 0 ||
      /\b(size|color|colour|variant|model)\b/i.test(q)) &&
    !isCatalogBrowseIntent(q, flags)
  ) {
    return true;
  }
  // Product-ish noun without list-all wording
  if (
    /\b(shoe|clog|sandal|sneaker|boot|product|item)\b/i.test(q) &&
    !isCatalogBrowseIntent(q, flags) &&
    !/\b(all|every|list|show\s+me\s+all)\b/i.test(q)
  ) {
    return true;
  }
  return false;
}

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
    primaryEntity: null,
    reason: "default_hybrid",
  };

  // --- Structural / specialized modes ---
  // Catalog list / browse → LISTING first (PLP), product only soft/secondary
  if (
    subIntent === "IN_PAGE_LIST" ||
    isCatalogBrowseIntent(q, flags)
  ) {
    strategy.mode = "catalog_list";
    strategy.primaryEntity = "listing";
    strategy.preferredEntityTypes = ["listing"];
    strategy.softEntityTypes = ["product"];
    strategy.preferredPageTypes = ["product"];
    strategy.hardFilterEntity = true;
    strategy.topK = Math.max(requestedTopK, 15);
    strategy.reason = "catalog_list_prefer_listing";
    if (sizes.length) {
      strategy.attributeHardFilters.sizes = sizes;
      strategy.hardFilterAttributes = false;
    }
    return strategy;
  }

  if (subIntent === "PAGE_LINKS" || flags.wantsProductLinks) {
    // Links to products: prefer listing grids (product_urls) then PDPs
    strategy.mode = "page_links";
    strategy.primaryEntity = "listing";
    strategy.preferredEntityTypes = ["listing"];
    strategy.softEntityTypes = ["product", "general"];
    strategy.hardFilterEntity = true;
    strategy.topK = Math.max(requestedTopK, 12);
    strategy.reason = "page_links_prefer_listing";
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

  const specificProduct = isSpecificProductIntent(q, flags, sizes);

  if (wantsFaq && !specificProduct) {
    strategy.preferredEntityTypes = ["faq", "policy"];
    strategy.softEntityTypes = ["product", "faq", "policy"];
    strategy.preferredPageTypes = ["faq", "product", "generic"];
    strategy.hardFilterEntity = true;
    strategy.primaryEntity = "faq";
    strategy.reason = "faq_policy_intent";
  } else if (wantsReview) {
    strategy.preferredEntityTypes = ["review"];
    strategy.softEntityTypes = ["product", "review"];
    strategy.hardFilterEntity = true;
    strategy.primaryEntity = "review";
    strategy.reason = "review_intent";
  } else if (wantsPolicy) {
    strategy.preferredEntityTypes = ["policy"];
    strategy.softEntityTypes = ["faq", "policy"];
    strategy.hardFilterEntity = true;
    strategy.primaryEntity = "policy";
    strategy.reason = "policy_intent";
  } else if (specificProduct) {
    // PDP only on first pass — do NOT hard-include listing (avoids PLP stealing the hit)
    strategy.mode = "product_detail";
    strategy.primaryEntity = "product";
    strategy.preferredEntityTypes = ["product"];
    strategy.softEntityTypes = ["faq", "review"]; // same-URL FAQ/review OK via soft; listing only on broaden
    strategy.preferredPageTypes = ["product"];
    strategy.hardFilterEntity = true;
    strategy.reason = "product_detail_prefer_pdp";
    if (sizes.length) {
      strategy.attributeHardFilters.sizes = sizes;
    }
  } else if (route === ROUTES.HYBRID) {
    strategy.reason = "hybrid_route";
    strategy.softEntityTypes = ["product", "listing", "faq", "general"];
    strategy.primaryEntity = "product";
  } else {
    strategy.mode = "semantic";
    strategy.reason = "semantic_default";
    // Mild product preference without hard-filtering listing out entirely
    strategy.softEntityTypes = [
      "product",
      "listing",
      "faq",
      "docs",
      "blog_post",
      "general",
    ];
    strategy.primaryEntity = "product";
  }

  strategy.topK = Math.max(strategy.topK, requestedTopK);
  return strategy;
}

/**
 * Broaden strategy for one retry:
 * - product_detail → allow listing as soft fallback (still prefer product)
 * - otherwise drop hard filters
 */
function broadenRetrievalStrategy(strategy = {}) {
  const isProductDetail =
    strategy.reason === "product_detail_prefer_pdp" ||
    strategy.mode === "product_detail" ||
    strategy.primaryEntity === "product";

  const isCatalog =
    strategy.mode === "catalog_list" ||
    strategy.primaryEntity === "listing";

  if (isProductDetail && !strategy.broadened) {
    return {
      ...strategy,
      // Keep hard filter on product+listing so we stay in commerce chunks
      preferredEntityTypes: ["product", "listing"],
      softEntityTypes: ["product", "listing", "faq", "review"],
      hardFilterEntity: true,
      hardFilterAttributes: false,
      topK: Math.min(40, Math.max((strategy.topK || 8) * 2, 16)),
      reason: `${strategy.reason || "default"}+broadened_include_listing`,
      broadened: true,
    };
  }

  if (isCatalog && !strategy.broadened) {
    return {
      ...strategy,
      preferredEntityTypes: ["listing", "product"],
      softEntityTypes: ["listing", "product", "general"],
      hardFilterEntity: true,
      hardFilterAttributes: false,
      topK: Math.min(40, Math.max((strategy.topK || 8) * 2, 16)),
      reason: `${strategy.reason || "default"}+broadened_include_product`,
      broadened: true,
    };
  }

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
  isCatalogBrowseIntent,
  isSpecificProductIntent,
};
