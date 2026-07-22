const { PAGE_TYPES, ENTITY_TYPES } = require("./schema");

/** Rule confidence at or above this skips LLM page-type classification. */
const RULE_CONFIDENCE_THRESHOLD = 0.72;

const SCHEMA_TO_PAGE = {
  product: { pageType: "product", entity_type: "product", weight: 0.92 },
  productgroup: { pageType: "product", entity_type: "listing", weight: 0.88 },
  individualproduct: { pageType: "product", entity_type: "product", weight: 0.9 },
  offer: { pageType: "product", entity_type: "product", weight: 0.55 },
  aggregateoffer: { pageType: "product", entity_type: "listing", weight: 0.7 },
  faqpage: { pageType: "faq", entity_type: "faq", weight: 0.95 },
  question: { pageType: "faq", entity_type: "faq", weight: 0.7 },
  article: { pageType: "blog", entity_type: "blog_post", weight: 0.85 },
  newsarticle: { pageType: "blog", entity_type: "blog_post", weight: 0.88 },
  blogposting: { pageType: "blog", entity_type: "blog_post", weight: 0.92 },
  techarticle: { pageType: "docs", entity_type: "docs", weight: 0.88 },
  howto: { pageType: "docs", entity_type: "docs", weight: 0.8 },
  webpage: { pageType: "generic", entity_type: "general", weight: 0.2 },
  aboutpage: { pageType: "generic", entity_type: "about", weight: 0.85 },
  contactpage: { pageType: "generic", entity_type: "about", weight: 0.8 },
  jobposting: { pageType: "generic", entity_type: "job_posting", weight: 0.9 },
  service: { pageType: "generic", entity_type: "service", weight: 0.75 },
};

const URL_RULES = [
  {
    re: /\/(products?|p|item|sku|dp)\//i,
    pageType: "product",
    entity_type: "product",
    score: 0.78,
  },
  {
    re: /\/(collections?|category|categories|catalog|shop)\//i,
    pageType: "product",
    entity_type: "listing",
    score: 0.7,
  },
  {
    re: /\/(faq|faqs|help|support)(\/|$)/i,
    pageType: "faq",
    entity_type: "faq",
    score: 0.82,
  },
  {
    re: /\/(docs?|documentation|developers?|api|guides?|reference)\//i,
    pageType: "docs",
    entity_type: "docs",
    score: 0.8,
  },
  {
    re: /\/(blog|news|articles?|posts?|insights)\//i,
    pageType: "blog",
    entity_type: "blog_post",
    score: 0.78,
  },
  {
    re: /\/(privacy|terms|policy|policies|legal)\//i,
    pageType: "generic",
    entity_type: "policy",
    score: 0.85,
  },
  {
    re: /\/(about|about-us|company|team)(\/|$)/i,
    pageType: "generic",
    entity_type: "about",
    score: 0.8,
  },
  {
    re: /\/(careers?|jobs?|job)\//i,
    pageType: "generic",
    entity_type: "job_posting",
    score: 0.75,
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

const FAQ_SCHEMA_KEYS = new Set(["faqpage", "question"]);

function schemaHasProduct(schemaTypes = []) {
  return schemaTypes.some((t) => PRODUCT_SCHEMA_KEYS.has(normalizeSchemaType(t)));
}

function schemaHasFaq(schemaTypes = []) {
  return schemaTypes.some((t) => FAQ_SCHEMA_KEYS.has(normalizeSchemaType(t)));
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
      best = { ...mapped, reason: `schema:${key}` };
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
      };
    }
  }
  return best;
}

/**
 * Light DOM / text signals (works with cheerio $ or plain hints).
 */
function scoreFromDom({ $, title = "", metaDescription = "", textSample = "" } = {}) {
  const signals = [];
  const hay = `${title} ${metaDescription} ${textSample}`.toLowerCase();

  if ($) {
    if ($('[itemtype*="Product"], [itemprop="offers"], .product-price, .price, [data-product-id]').length) {
      signals.push({
        pageType: "product",
        entity_type: "product",
        weight: 0.65,
        reason: "dom:product",
      });
    }
    if (
      $('script[type="application/ld+json"]').length === 0 &&
      ($(".faq, .faqs, [itemtype*='FAQPage'], details summary").length >= 2 ||
        $("[class*='accordion']").length >= 3)
    ) {
      signals.push({
        pageType: "faq",
        entity_type: "faq",
        weight: 0.6,
        reason: "dom:faq",
      });
    }
    if ($("article, [itemtype*='Article'], .blog-post, .post-content").length) {
      signals.push({
        pageType: "blog",
        entity_type: "blog_post",
        weight: 0.55,
        reason: "dom:article",
      });
    }
  }

  if (/\bfaq\b|frequently asked/i.test(hay)) {
    signals.push({
      pageType: "faq",
      entity_type: "faq",
      weight: 0.5,
      reason: "text:faq",
    });
  }
  if (/\b(add to cart|buy now|in stock|out of stock|sku)\b/i.test(hay)) {
    signals.push({
      pageType: "product",
      entity_type: "product",
      weight: 0.58,
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
 * Rule-based page type detection (Phase 3).
 * @returns {{ pageType, entity_type, confidence, reason, needsLlm, sources }}
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
      sources: [],
    };
  }

  // Prefer schema strongly; otherwise take highest weight, boost if URL+schema agree
  candidates.sort((a, b) => b.weight - a.weight);
  let best = candidates[0];

  // PDP conflict: product URL/schema must win over FAQ DOM/text/schema leftovers
  const urlIsProduct = fromUrl?.pageType === "product";
  const productInSchema = schemaHasProduct(schemaTypes);
  if (
    best.pageType === "faq" &&
    (productInSchema || urlIsProduct)
  ) {
    const productCandidate =
      candidates.find((c) => c.pageType === "product") ||
      (urlIsProduct ? fromUrl : null) ||
      (productInSchema
        ? {
            pageType: "product",
            entity_type: "product",
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

  const agreeing = candidates.filter(
    (c) => c.pageType === best.pageType || c.entity_type === best.entity_type,
  );
  let confidence = best.weight;
  if (agreeing.length >= 2) {
    confidence = Math.min(0.98, confidence + 0.12);
  }

  const pageType = PAGE_TYPES.includes(best.pageType)
    ? best.pageType
    : "generic";
  const entity_type = ENTITY_TYPES.includes(best.entity_type)
    ? best.entity_type
    : "general";

  confidence = clamp01(confidence);
  const needsLlm = confidence < RULE_CONFIDENCE_THRESHOLD;
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
    sources: agreeing.map((c) => c.reason),
    /** Hint for multi-section: FAQ coexists on a product page */
    secondaryFaq,
  };
}

module.exports = {
  detectPageType,
  RULE_CONFIDENCE_THRESHOLD,
  SCHEMA_TO_PAGE,
  normalizeSchemaType,
  schemaHasProduct,
  schemaHasFaq,
};
