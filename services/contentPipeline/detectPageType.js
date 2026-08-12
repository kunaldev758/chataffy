const { PAGE_TYPES, ENTITY_TYPES } = require("./schema");
const { GRID_SELECTORS } = require("./extractors/listing");

/** Rule confidence at or above this skips LLM page-type classification. */
const RULE_CONFIDENCE_THRESHOLD = 0.72;

/** At or above this, page is treated as fully deterministic (no page/section LLM). */
const DETERMINISTIC_CONFIDENCE = 0.85;

/**
 * Product-card selectors for page-type detection.
 * Intentionally narrower than listing CARD_SELECTORS (excludes layout-only
 * `.card-body` / bare `.grid__item`) so related-product chrome on PDPs is
 * less likely to flip a page to listing without a real product grid.
 */
const LISTING_CARD_SELECTORS = [
  ".grid-product",
  "[data-product-handle]",
  "[data-product-id]",
  ".product-card",
  ".product-item",
  "li.product",
  ".product-block",
  "article.card",
  ".productCard",
  "li.product-item",
  ".product-tile",
  "[class*='product-card' i]",
  "[class*='productCard' i]",
  "[class*='productTile' i]",
  "[class*='product-item' i]",
  "article.product",
].join(", ");

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
 * True for clear PDP URL shapes (/products/handle, /dp/asin, …).
 * Mirrored lightly here so DOM listing signals do not override known PDPs
 * inside detectPageType (full resolver still runs later in extractByPageType).
 */
function looksLikeProductDetailUrl(url = "") {
  if (!url) return false;
  let path = "";
  try {
    path = new URL(url, "http://localhost").pathname || "";
  } catch {
    path = String(url);
  }
  return /\/(products?|item|sku|dp|pd)\/[^/?#]+/i.test(path);
}

/**
 * Light DOM / text signals (works with cheerio $ or plain hints).
 * Listing grids reuse extractors/listing GRID_SELECTORS so BigCommerce /
 * Woo / Magento PLPs classify as product+listing even when URL rules miss.
 */
function scoreFromDom({
  $,
  title = "",
  metaDescription = "",
  textSample = "",
  url = "",
} = {}) {
  const signals = [];
  const hay = `${title} ${metaDescription} ${textSample}`.toLowerCase();
  const urlIsPdp = looksLikeProductDetailUrl(url);

  if ($) {
    if (
      $('[itemtype*="Product"], [itemprop="offers"], .product-form, [data-product-id]').length
    ) {
      signals.push({
        pageType: "product",
        entity_type: "product",
        weight: 0.7,
        reason: "dom:product",
      });
    }

    // Product listing / category grid (Shopify, BigCommerce, Woo, Magento, …)
    const gridCount = $(GRID_SELECTORS).length;
    if (gridCount > 0 && !urlIsPdp) {
      signals.push({
        pageType: "product",
        entity_type: "listing",
        weight: 0.82,
        reason: "dom:product_grid",
      });
    }

    // Multi product-card pages without a matched grid wrapper (custom themes).
    // Skip on clear PDP URLs so related-product carousels do not win.
    if (!urlIsPdp) {
      const cardCount = $(LISTING_CARD_SELECTORS).length;
      if (cardCount >= 2) {
        signals.push({
          pageType: "product",
          entity_type: "listing",
          // Slightly below grid so a real grid match stays preferred.
          weight: gridCount > 0 ? 0.8 : 0.78,
          reason: `dom:product_cards:${cardCount}`,
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
    if ($("article, [itemtype*='Article'], .blog-post, .post-content").length) {
      signals.push({
        pageType: "blog",
        entity_type: "blog_post",
        weight: 0.6,
        reason: "dom:article",
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
  if (/\b(add to cart|buy now|in stock|out of stock|sku)\b/i.test(hay)) {
    signals.push({
      pageType: "product",
      // Prefer listing when multi-card/grid already signaled; else PDP-ish.
      entity_type: "product",
      weight: 0.62,
      reason: "text:commerce",
    });
  }

  let best = null;
  for (const s of signals) {
    if (!best || s.weight > best.weight) best = s;
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
  fromDom = null,
} = {}) {
  if (confidence >= DETERMINISTIC_CONFIDENCE) return true;
  if (fromUrl?.deterministic) return true;
  if (fromSchema?.deterministic && fromSchema.pageType === pageType) return true;

  // Explicit ecommerce / FAQ contracts
  if (entity_type === "listing" && /\/(collections?|category|categories|catalog)(\/|$)/i.test(url)) {
    return true;
  }
  // Strong DOM listing grid (BigCommerce/custom PLPs without collection URL)
  if (
    pageType === "product" &&
    entity_type === "listing" &&
    confidence >= 0.8 &&
    fromDom?.entity_type === "listing"
  ) {
    return true;
  }
  if (
    pageType === "product" &&
    entity_type === "product" &&
    (/\/(products?|p|item|sku|dp)\//i.test(url) || schemaHasProduct(schemaTypes))
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
  const fromDom = scoreFromDom({
    $,
    title,
    metaDescription,
    textSample,
    url,
  });
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

  // PDP conflict: product URL/schema must win over FAQ DOM/text/schema leftovers
  const urlIsProduct =
    fromUrl?.pageType === "product" && fromUrl?.entity_type === "product";
  const urlIsListing =
    fromUrl?.pageType === "product" && fromUrl?.entity_type === "listing";
  const productInSchema = schemaHasProduct(schemaTypes);

  if (best.pageType === "faq" && (productInSchema || urlIsProduct || urlIsListing)) {
    const productCandidate =
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

  // URL listing always wins entity_type on collection URLs
  if (urlIsListing) {
    best = {
      ...best,
      pageType: "product",
      entity_type: "listing",
      weight: Math.max(best.weight, fromUrl.weight),
      reason: `${best.reason}+url_listing`,
      deterministic: true,
    };
  }

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
    fromDom,
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
};
