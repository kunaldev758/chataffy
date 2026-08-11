const { PAGE_TYPES, ENTITY_TYPES } = require("./schema");

/** Rule confidence at or above this skips LLM page-type classification. */
const RULE_CONFIDENCE_THRESHOLD = 0.72;

/** At or above this, page is treated as fully deterministic (no page/section LLM). */
const DETERMINISTIC_CONFIDENCE = 0.85;

const SCHEMA_TO_PAGE = {
  product: { pageType: "product", entity_type: "product", weight: 0.94 },
  productgroup: { pageType: "product", entity_type: "listing", weight: 0.9 },
  individualproduct: { pageType: "product", entity_type: "product", weight: 0.92 },
  offer: { pageType: "product", entity_type: "product", weight: 0.55 },
  aggregateoffer: { pageType: "product", entity_type: "listing", weight: 0.78 },
  itemlist: { pageType: "product", entity_type: "listing", weight: 0.88 },
  offercatalog: { pageType: "product", entity_type: "listing", weight: 0.86 },
  faqpage: { pageType: "faq", entity_type: "faq", weight: 0.96 },
  question: { pageType: "faq", entity_type: "faq", weight: 0.72 },
  article: { pageType: "blog", entity_type: "blog_post", weight: 0.86 },
  newsarticle: { pageType: "blog", entity_type: "blog_post", weight: 0.88 },
  blogposting: { pageType: "blog", entity_type: "blog_post", weight: 0.92 },
  techarticle: { pageType: "docs", entity_type: "docs", weight: 0.88 },
  howto: { pageType: "docs", entity_type: "docs", weight: 0.82 },
  webpage: { pageType: "generic", entity_type: "general", weight: 0.2 },
  aboutpage: { pageType: "generic", entity_type: "about", weight: 0.88 },
  contactpage: { pageType: "generic", entity_type: "about", weight: 0.85 },
  jobposting: { pageType: "generic", entity_type: "job_posting", weight: 0.92 },
  service: { pageType: "generic", entity_type: "service", weight: 0.78 },
};

const URL_RULES = [
  {
    // Pricing pages often contain an FAQ section, but the page's primary
    // content is the plan, price, limits, and included features.
    re: /\/(pricing|plans?|subscriptions?|rates?)(\/|$)/i,
    pageType: "generic",
    entity_type: "general",
    score: 0.97,
    deterministic: true,
  },
  {
    re: /\/(products?|p|item|sku|dp)\//i,
    pageType: "product",
    entity_type: "product",
    score: 0.9,
    deterministic: true,
  },
  {
    re: /\/(collections?|category|categories|catalog)(\/|$)/i,
    pageType: "product",
    entity_type: "listing",
    score: 0.88,
    deterministic: true,
  },
  {
    re: /\/(faq|faqs)(\/|$)/i,
    pageType: "faq",
    entity_type: "faq",
    score: 0.9,
    deterministic: true,
  },
  {
    re: /\/(help|support)(\/|$)/i,
    pageType: "faq",
    entity_type: "faq",
    score: 0.78,
  },
  {
    re: /\/(docs?|documentation|developers?|api|guides?|reference)\//i,
    pageType: "docs",
    entity_type: "docs",
    score: 0.86,
    deterministic: true,
  },
  {
    re: /\/(blog|news|articles?|posts?|insights)\//i,
    pageType: "blog",
    entity_type: "blog_post",
    score: 0.84,
  },
  {
    re: /\/(privacy|terms|policy|policies|legal)(\/|$)/i,
    pageType: "generic",
    entity_type: "policy",
    score: 0.9,
    deterministic: true,
  },
  {
    re: /\/(about|about-us|company|team)(\/|$)/i,
    pageType: "generic",
    entity_type: "about",
    score: 0.86,
    deterministic: true,
  },
  {
    re: /\/(careers?|jobs?|job)(\/|$)/i,
    pageType: "generic",
    entity_type: "job_posting",
    score: 0.82,
  },
  {
    // Generic shop index — listing-ish but weaker
    re: /\/shop(\/|$)/i,
    pageType: "product",
    entity_type: "listing",
    score: 0.72,
  },
  {
    re: /\/(brands?|vendors?|manufacturers?)(\/|$)/i,
    pageType: "product",
    entity_type: "listing",
    score: 0.8,
    deterministic: true,
  },
];

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

/** Normalize schema.org @type (handles https://schema.org/Product etc.). */
function normalizeSchemaType(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/schema\.org\//, "")
    .replace(/^schema\.org\//, "");
}

const PRODUCT_SCHEMA_KEYS = new Set([
  "product",
  "productgroup",
  "individualproduct",
  "offer",
  "aggregateoffer",
]);

const LISTING_SCHEMA_KEYS = new Set([
  "productgroup",
  "aggregateoffer",
  "itemlist",
  "offercatalog",
]);

const FAQ_SCHEMA_KEYS = new Set(["faqpage", "question"]);

function schemaHasProduct(schemaTypes = []) {
  return schemaTypes.some((t) => PRODUCT_SCHEMA_KEYS.has(normalizeSchemaType(t)));
}

function schemaHasFaq(schemaTypes = []) {
  return schemaTypes.some((t) => FAQ_SCHEMA_KEYS.has(normalizeSchemaType(t)));
}

function schemaHasFaqPage(schemaTypes = []) {
  return schemaTypes.some((t) => normalizeSchemaType(t) === "faqpage");
}

function schemaHasListing(schemaTypes = []) {
  return schemaTypes.some((t) => LISTING_SCHEMA_KEYS.has(normalizeSchemaType(t)));
}

function scoreFromSchema(schemaTypes = []) {
  const hasProduct = schemaHasProduct(schemaTypes);
  let best = null;
  for (const raw of schemaTypes) {
    const key = normalizeSchemaType(raw);
    const mapped = SCHEMA_TO_PAGE[key];
    if (!mapped) continue;
    // FAQPage often coexists on PDPs — do not let it beat Product for primary type
    if (hasProduct && mapped.pageType === "faq") continue;
    if (!best || mapped.weight > best.weight) {
      best = {
        ...mapped,
        reason: `schema:${key}`,
        deterministic: ["product", "faqpage", "blogposting", "itemlist"].includes(
          key,
        ),
      };
    }
  }
  return best;
}

function scoreFromUrl(url = "") {
  let best = null;
  for (const rule of URL_RULES) {
    if (!rule.re.test(url)) continue;
    if (!best || rule.score > best.score) {
      best = {
        pageType: rule.pageType,
        entity_type: rule.entity_type,
        weight: rule.score,
        reason: `url:${rule.re}`,
        deterministic: Boolean(rule.deterministic),
      };
    }
  }
  return best;
}

/**
 * PLP / category grids — primary listing containers (not related rails).
 * Aligned with extractors/listing.js; omit ultra-vague bare classes when possible.
 */
const DOM_LISTING_GRID_SELECTORS = [
  // Shopify
  "#ProductGridContainer",
  "#product-grid",
  ".product-grid",
  ".collection-products",
  ".collection__products",
  "[data-product-grid]",
  ".products-list",
  ".collection-grid",
  ".shop-grid",
  // BigCommerce
  "#product-listing-container",
  ".productGrid",
  "ul.productGrid",
  ".productBlockContainer",
  // Woo / Magento / generic listing roots
  ".woocommerce-page ul.products",
  ".wc-block-grid__products",
  ".products-grid",
  ".product-grid-container",
  "[class*='product-grid' i]",
  "[class*='productGrid' i]",
  "[class*='productListing' i]",
  "[class*='category-products' i]",
].join(", ");

/**
 * Product cards — used only inside primary listing region (or related-scoped checks).
 */
const DOM_PRODUCT_CARD_SELECTORS = [
  "[data-product-id]",
  "[data-product-handle]",
  ".product-card",
  ".product-item",
  ".product-block",
  ".productCard",
  "li.product",
  "article.card",
  ".product-tile",
  ".product-box",
  "[class*='product-card' i]",
  "[class*='productCard' i]",
  "[class*='product-item' i]",
].join(", ");

/** Strong single-product shell (BigCommerce + Shopify + generic). */
const DOM_PRIMARY_PDP_SELECTORS = [
  ".productView",
  ".productView-details",
  ".productView-product",
  "[data-entity='Product']",
  "form[data-cart-item-add]",
  "form[action*='cart.php?action=add']",
  ".product-form",
  "form.product-form",
  ".product__info-wrapper",
  ".product-single",
  "#ProductSection",
  ".product-details",
  ".product-info-main",
  "[itemtype*='Product'] form",
  "[itemtype*='Product'] .price",
].join(", ");

/**
 * Secondary ecommerce regions — related / upsell / recently viewed.
 * Cards inside these must NOT flip a PDP to listing.
 */
const DOM_SECONDARY_REGION_SELECTORS = [
  "[id*='related' i]",
  "[class*='related' i]",
  "[id*='upsell' i]",
  "[class*='upsell' i]",
  "[id*='crosssell' i]",
  "[class*='cross-sell' i]",
  "[class*='crosssell' i]",
  "[id*='recently' i]",
  "[class*='recently-viewed' i]",
  "[class*='recently_viewed' i]",
  "[class*='you-may' i]",
  "[class*='you-might' i]",
  "[class*='recommendations' i]",
  "[class*='recommended' i]",
  "[class*='also-like' i]",
  "[class*='also_bought' i]",
  "[data-product-recommendations]",
  "product-recommendations",
  ".productReviews",
  "#product-reviews",
].join(", ");

function isInsideSecondaryRegion($el) {
  if (!$el || !$el.length) return false;
  return $el.closest(DOM_SECONDARY_REGION_SELECTORS).length > 0;
}

function isInsidePrimaryPdp($el) {
  if (!$el || !$el.length) return false;
  return $el.closest(DOM_PRIMARY_PDP_SELECTORS).length > 0;
}

/**
 * True when the page has a primary product-detail shell (not merely related cards).
 */
function hasPrimaryPdpDom($) {
  if (!$ || !$.root) return false;
  const roots = $(DOM_PRIMARY_PDP_SELECTORS);
  if (!roots.length) return false;
  // At least one primary shell outside pure related widgets
  let primary = 0;
  roots.each((_, el) => {
    const $el = $(el);
    if (!isInsideSecondaryRegion($el)) primary += 1;
  });
  return primary > 0;
}

/**
 * Count listing cards inside primary grid containers only.
 * Falls back to body cards that are NOT in secondary / PDP shells.
 */
function countPrimaryListingCards($) {
  if (!$ || !$.root) return { gridCount: 0, cardCount: 0 };

  const grids = $(DOM_LISTING_GRID_SELECTORS).filter((_, el) => {
    const $el = $(el);
    if (isInsideSecondaryRegion($el)) return false;
    if (isInsidePrimaryPdp($el)) return false;
    return true;
  });
  const gridCount = grids.length;

  let cardCount = 0;
  if (gridCount > 0) {
    grids.each((_, grid) => {
      cardCount += $(grid).find(DOM_PRODUCT_CARD_SELECTORS).length;
    });
  } else {
    // No named grid — count top-level cards outside secondary / PDP
    $(DOM_PRODUCT_CARD_SELECTORS).each((_, el) => {
      const $el = $(el);
      if (isInsideSecondaryRegion($el)) return;
      if (isInsidePrimaryPdp($el)) return;
      cardCount += 1;
    });
  }

  return { gridCount, cardCount };
}

/**
 * Soft URL check: classic PDP path shapes (Shopify/Amazon-style).
 */
function isStrongProductDetailUrl(url = "") {
  if (!url) return false;
  let path = "";
  try {
    path = new URL(url, "http://localhost").pathname || "";
  } catch {
    path = String(url);
  }
  return /\/(products?|item|sku|dp|pd)\/[^/?#]+/i.test(path);
}

function isStrongListingUrl(url = "") {
  if (!url) return false;
  let path = "";
  try {
    path = new URL(url, "http://localhost").pathname || "";
  } catch {
    path = String(url);
  }
  if (
    /\/(collections?|category|categories|catalog|all-products|search|browse|brands?|vendors?|goods)(\/|$)/i.test(
      path,
    )
  ) {
    return true;
  }
  if (/\/(shop|store)\/?$/i.test(path)) return true;
  if (/\/products?\/?$/i.test(path)) return true;
  return false;
}

/**
 * Light DOM / text signals for page type.
 * Precedence: primary PDP region beats related cards / global CTAs.
 */
function scoreFromDom({ $, title = "", metaDescription = "", textSample = "" } = {}) {
  const signals = [];
  const hay = `${title} ${metaDescription} ${textSample}`.toLowerCase();
  const titleLower = String(title || "").toLowerCase();

  let listingEvidence = false;
  let productPdpEvidence = false;

  if ($) {
    const primaryPdp = hasPrimaryPdpDom($);
    const { gridCount, cardCount } = countPrimaryListingCards($);

    // --- Primary PDP (hard commerce entity: product) ---
    if (primaryPdp) {
      productPdpEvidence = true;
      signals.push({
        pageType: "product",
        entity_type: "product",
        weight: 0.92,
        reason: "dom:primary_pdp",
        deterministic: true,
      });
    }

    // --- Primary PLP only when not a primary PDP ---
    if (!primaryPdp) {
      if (gridCount > 0 && cardCount >= 2) {
        listingEvidence = true;
        signals.push({
          pageType: "product",
          entity_type: "listing",
          weight: 0.9,
          reason: "dom:primary_listing_grid",
          deterministic: true,
        });
      } else if (gridCount > 0 && cardCount >= 1) {
        listingEvidence = true;
        signals.push({
          pageType: "product",
          entity_type: "listing",
          weight: 0.8,
          reason: "dom:primary_listing_grid_thin",
        });
      } else if (cardCount >= 2) {
        listingEvidence = true;
        signals.push({
          pageType: "product",
          entity_type: "listing",
          weight: Math.min(0.88, 0.76 + Math.min(cardCount, 8) * 0.01),
          reason: "dom:primary_product_cards",
          deterministic: cardCount >= 3,
        });
      } else if (cardCount === 1) {
        signals.push({
          pageType: "product",
          entity_type: "listing",
          weight: 0.66,
          reason: "dom:single_product_card",
        });
      }
    }

    // Weak Product schema / offers outside hard PDP (do not beat primary PDP)
    if (!primaryPdp) {
      const weakPdp = $(
        '[itemtype*="Product"], [itemprop="offers"], .product-form',
      ).filter((_, el) => !isInsideSecondaryRegion($(el))).length;
      if (weakPdp > 0 && !listingEvidence) {
        productPdpEvidence = true;
        signals.push({
          pageType: "product",
          entity_type: "product",
          weight: 0.68,
          reason: "dom:product",
        });
      }
    }

    if (
      $('script[type="application/ld+json"]').length === 0 &&
      ($(".faq, .faqs, [itemtype*='FAQPage']").length >= 1 ||
        ($("details summary").filter((_, el) => {
          const $el = $(el);
          if (
            $el.closest(
              "aside, [role='complementary'], .facets, [class*='facet'], [class*='Facet'], facet-filters-form, [class*='filter-sidebar']",
            ).length
          ) {
            return false;
          }
          const t = $el.text().replace(/\s+/g, " ").trim();
          return !/^(collections?|filter|filters|sort|price|size|color|brand|availability)$/i.test(
            t,
          );
        }).length >= 2))
    ) {
      signals.push({
        pageType: "faq",
        entity_type: "faq",
        weight: 0.62,
        reason: "dom:faq",
      });
    }

    // Blog only when no primary ecommerce
    if (!listingEvidence && !productPdpEvidence) {
      const blogNodes = $(
        "article:not(.card):not(.product):not(.productCard), [itemtype*='Article'], .blog-post, .post-content, .article-body, .blog-content",
      );
      const realBlog = blogNodes.filter((_, el) => {
        const $el = $(el);
        if ($el.is(DOM_PRODUCT_CARD_SELECTORS)) return false;
        if ($el.closest(DOM_LISTING_GRID_SELECTORS).length) return false;
        if (isInsideSecondaryRegion($el)) return false;
        return true;
      }).length;
      if (realBlog > 0) {
        signals.push({
          pageType: "blog",
          entity_type: "blog_post",
          weight: 0.6,
          reason: "dom:article",
        });
      }
    }

    // Text CTAs: multi hit implies listing ONLY without primary PDP
    // (PDPs often repeat Add to Cart in related blocks)
    const commerceHits = (
      hay.match(/\b(add to cart|buy now|add to bag|add to basket)\b/gi) || []
    ).length;
    const stockHits = (
      hay.match(/\b(in stock|out of stock|msrp|sku)\b/gi) || []
    ).length;

    if (!primaryPdp) {
      if (commerceHits >= 2 && (listingEvidence || cardCount >= 2 || gridCount > 0)) {
        listingEvidence = true;
        signals.push({
          pageType: "product",
          entity_type: "listing",
          weight: 0.78,
          reason: "text:commerce_multi",
        });
      } else if (commerceHits >= 1 || stockHits >= 1) {
        signals.push({
          pageType: "product",
          entity_type: listingEvidence ? "listing" : "product",
          weight: listingEvidence ? 0.72 : 0.62,
          reason: "text:commerce",
        });
      }
    } else if (commerceHits >= 1 || stockHits >= 1) {
      // Soft reinforce PDP only
      signals.push({
        pageType: "product",
        entity_type: "product",
        weight: 0.64,
        reason: "text:commerce_pdp",
      });
    }

    // Title "… Products" only soft-lists when NOT primary PDP
    if (
      !primaryPdp &&
      /\bproducts?\b/i.test(titleLower) &&
      !/\b(blog|news|article|post)\b/i.test(titleLower)
    ) {
      signals.push({
        pageType: "product",
        entity_type: "listing",
        weight: 0.7,
        reason: "title:products",
      });
    }
  } else {
    // No DOM: text/title only (weaker)
    const commerceHits = (
      hay.match(/\b(add to cart|buy now|add to bag|add to basket)\b/gi) || []
    ).length;
    if (commerceHits >= 2) {
      signals.push({
        pageType: "product",
        entity_type: "listing",
        weight: 0.7,
        reason: "text:commerce_multi",
      });
    } else if (commerceHits >= 1) {
      signals.push({
        pageType: "product",
        entity_type: "product",
        weight: 0.62,
        reason: "text:commerce",
      });
    }
    if (
      /\bproducts?\b/i.test(titleLower) &&
      !/\b(blog|news|article|post)\b/i.test(titleLower)
    ) {
      signals.push({
        pageType: "product",
        entity_type: "listing",
        weight: 0.68,
        reason: "title:products",
      });
    }
  }

  if (/\bfaq\b|frequently asked/i.test(hay)) {
    signals.push({
      pageType: "faq",
      entity_type: "faq",
      weight: 0.52,
      reason: "text:faq",
    });
  }

  let best = null;
  for (const s of signals) {
    if (!best || s.weight > best.weight) best = s;
    else if (
      best &&
      s.weight === best.weight &&
      // On tie: prefer product (PDP) over listing to protect related-card noise
      s.entity_type === "product" &&
      best.entity_type === "listing" &&
      (s.reason || "").includes("primary_pdp")
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * True when rules alone are trustworthy enough to skip all classification LLMs.
 */
function isDeterministicPageType({
  pageType,
  entity_type,
  confidence,
  url = "",
  schemaTypes = [],
  fromUrl = null,
  fromSchema = null,
} = {}) {
  if (confidence >= DETERMINISTIC_CONFIDENCE) return true;
  if (fromUrl?.deterministic) return true;
  if (fromSchema?.deterministic && fromSchema.pageType === pageType) return true;

  // Explicit ecommerce / FAQ contracts
  if (
    entity_type === "listing" &&
    /\/(collections?|category|categories|catalog|brands?|vendors?)(\/|$)/i.test(
      url,
    )
  ) {
    return true;
  }
  // Strong primary listing DOM (not related rails)
  if (
    pageType === "product" &&
    entity_type === "listing" &&
    confidence >= 0.85 &&
    fromSchema?.entity_type !== "product"
  ) {
    return true;
  }
  if (
    pageType === "product" &&
    entity_type === "product" &&
    (isStrongProductDetailUrl(url) ||
      schemaHasProduct(schemaTypes) ||
      confidence >= 0.9)
  ) {
    return true;
  }
  if (pageType === "faq" && schemaHasFaqPage(schemaTypes)) return true;
  if (entity_type === "policy" && /\/(privacy|terms|policy|policies|legal)(\/|$)/i.test(url)) {
    return true;
  }
  if (pageType === "docs" && /\/(docs?|documentation|developers?|api)\//i.test(url)) {
    return true;
  }

  return false;
}

/**
 * Rule-based page type detection (Phase 3).
 * @returns {{ pageType, entity_type, confidence, reason, needsLlm, deterministic, sources }}
 */
function detectPageType({
  url = "",
  schemaTypes = [],
  title = "",
  metaDescription = "",
  textSample = "",
  $ = null,
} = {}) {
  const candidates = [];
  const fromSchema = scoreFromSchema(schemaTypes);
  if (fromSchema) candidates.push(fromSchema);
  const fromUrl = scoreFromUrl(url);
  if (fromUrl) candidates.push(fromUrl);
  const fromDom = scoreFromDom({ $, title, metaDescription, textSample });
  if (fromDom) candidates.push(fromDom);

  if (candidates.length === 0) {
    return {
      pageType: "generic",
      entity_type: "general",
      confidence: 0.25,
      reason: "no_rule_match",
      needsLlm: true,
      deterministic: false,
      sources: [],
    };
  }

  candidates.sort((a, b) => b.weight - a.weight);
  let best = candidates[0];

  // Hard precedence (P0):
  // 1) strong PDP URL → product
  // 2) primary PDP DOM signal → product (ignore related listing noise)
  // 3) strong PLP URL → listing
  // 4) primary listing signal remains when no PDP
  const urlIsProduct =
    fromUrl?.pageType === "product" && fromUrl?.entity_type === "product";
  const urlIsListing =
    fromUrl?.pageType === "product" && fromUrl?.entity_type === "listing";
  const productInSchema = schemaHasProduct(schemaTypes);
  const primaryPdpDom = Boolean($ && hasPrimaryPdpDom($));
  const primaryPdpCandidate = candidates.find(
    (c) =>
      c.pageType === "product" &&
      c.entity_type === "product" &&
      /primary_pdp|force_product/i.test(c.reason || ""),
  );
  const primaryListingCandidate = candidates
    .filter(
      (c) =>
        c.pageType === "product" &&
        c.entity_type === "listing" &&
        /primary_listing|primary_product_cards/i.test(c.reason || ""),
    )
    .sort((a, b) => b.weight - a.weight)[0];

  if (urlIsProduct || isStrongProductDetailUrl(url)) {
    best = {
      pageType: "product",
      entity_type: "product",
      weight: Math.max(best.weight, 0.95),
      reason: `${best.reason}+force_product_url`,
      deterministic: true,
    };
  } else if (primaryPdpDom || primaryPdpCandidate) {
    const base = primaryPdpCandidate || {
      pageType: "product",
      entity_type: "product",
      weight: 0.92,
      reason: "dom:primary_pdp",
      deterministic: true,
    };
    best = {
      ...base,
      pageType: "product",
      entity_type: "product",
      weight: Math.max(base.weight, 0.92),
      reason: `${base.reason}+prefer_primary_pdp`,
      deterministic: true,
    };
  } else if (urlIsListing || isStrongListingUrl(url)) {
    best = {
      pageType: "product",
      entity_type: "listing",
      weight: Math.max(best.weight, fromUrl?.weight || 0.88),
      reason: `${best.reason}+url_listing`,
      deterministic: true,
    };
  } else if (
    primaryListingCandidate &&
    best.entity_type !== "listing" &&
    best.pageType === "product"
  ) {
    // Only promote listing when not a PDP case (handled above)
    best = {
      ...primaryListingCandidate,
      reason: `${primaryListingCandidate.reason}+prefer_primary_listing`,
    };
  }

  // FAQ must not beat real ecommerce
  if (best.pageType === "faq" && (productInSchema || urlIsProduct || urlIsListing || primaryPdpDom)) {
    const productCandidate =
      primaryPdpCandidate ||
      candidates.find((c) => c.pageType === "product") ||
      (urlIsProduct || urlIsListing ? fromUrl : null) ||
      (productInSchema
        ? {
            pageType: "product",
            entity_type: schemaHasListing(schemaTypes) ? "listing" : "product",
            weight: 0.9,
            reason: "schema:product_preferred",
          }
        : null);
    if (productCandidate) {
      best = {
        ...productCandidate,
        reason: `${productCandidate.reason}+prefer_product_over_faq`,
      };
    }
  }

  // Blog must not beat real ecommerce
  if (best.pageType === "blog") {
    const productCandidate = candidates.find((c) => c.pageType === "product");
    if (productCandidate) {
      best = {
        ...productCandidate,
        reason: `${productCandidate.reason}+prefer_product_over_blog`,
      };
    }
  }

  // note: deliberately NO prefer_listing_over_pdp (related cards must not win)
  const agreeing = candidates.filter(
    (c) => c.pageType === best.pageType || c.entity_type === best.entity_type,
  );
  let confidence = best.weight;
  if (agreeing.length >= 2) {
    confidence = Math.min(0.98, confidence + 0.12);
  }
  // Strong single-source ecommerce URL / FAQPage schema
  if (best.deterministic && confidence < DETERMINISTIC_CONFIDENCE) {
    confidence = Math.max(confidence, DETERMINISTIC_CONFIDENCE);
  }

  const pageType = PAGE_TYPES.includes(best.pageType)
    ? best.pageType
    : "generic";
  const entity_type = ENTITY_TYPES.includes(best.entity_type)
    ? best.entity_type
    : "general";

  confidence = clamp01(confidence);

  const deterministic = isDeterministicPageType({
    pageType,
    entity_type,
    confidence,
    url,
    schemaTypes,
    fromUrl,
    fromSchema,
  });

  const needsLlm = !deterministic && confidence < RULE_CONFIDENCE_THRESHOLD;

  const secondaryFaq =
    schemaHasFaq(schemaTypes) && pageType === "product"
      ? true
      : Boolean(
          pageType === "product" &&
            candidates.some((c) => c.pageType === "faq"),
        );

  return {
    pageType,
    entity_type,
    confidence,
    reason: agreeing.map((c) => c.reason).join("+") || best.reason,
    needsLlm,
    deterministic,
    sources: agreeing.map((c) => c.reason),
    /** Hint for multi-section: FAQ coexists on a product page */
    secondaryFaq,
  };
}

module.exports = {
  detectPageType,
  isDeterministicPageType,
  RULE_CONFIDENCE_THRESHOLD,
  DETERMINISTIC_CONFIDENCE,
  SCHEMA_TO_PAGE,
  normalizeSchemaType,
  schemaHasProduct,
  schemaHasFaq,
  schemaHasFaqPage,
  schemaHasListing,
  DOM_LISTING_GRID_SELECTORS,
  DOM_PRODUCT_CARD_SELECTORS,
  DOM_PRIMARY_PDP_SELECTORS,
  DOM_SECONDARY_REGION_SELECTORS,
  scoreFromDom,
  scoreFromUrl,
  hasPrimaryPdpDom,
  countPrimaryListingCards,
  isStrongProductDetailUrl,
  isStrongListingUrl,
};
