const { ENTITY_TYPE, PAGE_ENTITY_TYPES } = require("../constants/contentTypes");

const PRICE_CORE = String.raw`(?:\$|€|£|₹)\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:USD|EUR|GBP|INR)\b`;
const PRICE_PATTERN = new RegExp(PRICE_CORE, "i");
const PRICE_PATTERN_G = new RegExp(PRICE_CORE, "gi");
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /(?:\+?\d[\s\-().]?){7,}\d/;

function normalize(text) {
  return (text || "").toLowerCase();
}

// Match URL heuristics against the path only, so a host like "shop.com"
// or "products.example.com" doesn't create false positives.
function urlPath(url) {
  if (!url) return "";
  try {
    return new URL(url).pathname.toLowerCase();
  } catch (_) {
    const noProtocol = String(url).replace(/^[a-z]+:\/\//i, "");
    const slash = noProtocol.indexOf("/");
    return (slash === -1 ? "" : noProtocol.slice(slash)).toLowerCase();
  }
}

function countMatches(text, pattern) {
  const matches = (text || "").match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Product Detector — pages that sell or list purchasable products.
 * Fires for both single product pages AND listing/collection pages that
 * contain products (so a collection page is tagged both category + product).
 */
function detectProduct({ path = "", combined = "" }) {
  if (/\/products?(?:\/|$)/i.test(path)) return true;

  // Commerce / stock / cart signals (single product or listing).
  if (/\b(add to cart|add to bag|add to basket|buy now|out of stock|in stock|sold out|sale price|regular price|sku|product code)\b/i.test(combined)) {
    return true;
  }

  // Catalog count, e.g. "26 products".
  if (/\b\d+\s+products?\b/i.test(combined)) return true;

  // Multiple priced items on the page => a product listing.
  if (countMatches(combined, PRICE_PATTERN_G) >= 2) return true;

  // A single priced item together with a shopping context signal.
  if (
    PRICE_PATTERN.test(combined) &&
    /\b(variant|size|color|colour|quantity|checkout|reviews?|add to)\b/i.test(combined)
  ) {
    return true;
  }

  return false;
}

/**
 * FAQ Detector — pages that answer frequently asked questions.
 */
function detectFaq({ path = "", combined = "" }) {
  if (/\/(faqs?|help|support|questions?)\b/i.test(path)) return true;
  if (/\bfrequently asked questions\b/i.test(combined)) return true;
  // Repeated Q/A structure
  if (countMatches(combined, /\bq\s*[:.\-)]/gi) >= 2 && countMatches(combined, /\ba\s*[:.\-)]/gi) >= 2) {
    return true;
  }
  if (countMatches(combined, /\?/g) >= 3 && /\b(answer|how do|how can|what is|can i|do you)\b/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * Contact Detector — pages providing contact details.
 */
function detectContact({ path = "", combined = "" }) {
  if (/\/(contact|contact-us|get-in-touch|reach-us)\b/i.test(path)) return true;
  if (/\b(contact us|get in touch|reach us|email us|call us)\b/i.test(combined)) return true;
  const hasEmail = EMAIL_PATTERN.test(combined);
  const hasPhone = PHONE_PATTERN.test(combined);
  const hasAddress = /\b(address|our office|headquarters|located at|visit us)\b/i.test(combined);
  if ((hasEmail || hasPhone) && hasAddress) return true;
  return false;
}

/**
 * Service Detector — pages describing offered services.
 */
function detectService({ path = "", combined = "" }) {
  if (/\/services?\b/i.test(path)) return true;
  if (/\b(our services|services we offer|what we offer|book (?:a|an) (?:appointment|consultation)|schedule (?:a|an) (?:appointment|consultation)|request a quote)\b/i.test(combined)) {
    return true;
  }
  if (/\b(consultation|appointment|servicing|we provide|we specialize|we specialise)\b/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * Category Detector — listing / collection / catalog pages.
 */
function detectCategory({ path = "", combined = "" }) {
  if (/\/(collections?|categor(?:y|ies)|catalog(?:ue)?|shop|store)\b/i.test(path)) return true;
  if (/\b(shop by|browse (?:our )?(?:products|catalog|collection)|all products|view all|product category|our collection)\b/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * About Detector — company / about-us / story pages.
 */
function detectAbout({ path = "", combined = "" }) {
  if (/\/(about|about-us|our-story|who-we-are|company|mission|our-team)\b/i.test(path)) return true;
  if (/\b(about us|our story|our mission|who we are|our vision|our values|founded in|est(?:ablished)?\.?\s*\d{4}|meet the team)\b/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * Blog Detector — blog / news / article pages.
 */
function detectBlog({ path = "", combined = "" }) {
  if (/\/(blogs?|news|articles?|posts?|stories)\b/i.test(path)) return true;
  if (/\b(posted on|published on|read more|min read|written by|\d+\s+comments?)\b/i.test(combined)) {
    return true;
  }
  if (/\bby\s+[a-z][a-z.'-]+\b/i.test(combined) && /\b(read more|continue reading|share this (?:post|article))\b/i.test(combined)) {
    return true;
  }
  return false;
}

const DETECTORS = {
  [ENTITY_TYPE.PRODUCT]: detectProduct,
  [ENTITY_TYPE.FAQ]: detectFaq,
  [ENTITY_TYPE.CONTACT]: detectContact,
  [ENTITY_TYPE.SERVICE]: detectService,
  [ENTITY_TYPE.CATEGORY]: detectCategory,
  [ENTITY_TYPE.ABOUT]: detectAbout,
  [ENTITY_TYPE.BLOG]: detectBlog,
};

/**
 * Run every detector against a page and return the list of matched entity types.
 *
 * @param {{ url?: string, title?: string, content?: string, metaDescription?: string }} page
 * @returns {string[]} deduped subset of PAGE_ENTITY_TYPES (may be empty)
 */
function detectEntityTypes({ url = "", title = "", content = "", metaDescription = "" } = {}) {
  const combined = normalize(`${title}\n${metaDescription}\n${content}`);
  const context = { url: url || "", path: urlPath(url), combined };

  const detected = [];
  for (const entityType of PAGE_ENTITY_TYPES) {
    const detector = DETECTORS[entityType];
    try {
      if (detector && detector(context)) {
        detected.push(entityType);
      }
    } catch (err) {
      // A single failing detector must not break the pipeline.
      console.error(`[entityTypeDetector] ${entityType} detector failed:`, err.message);
    }
  }

  return detected;
}

module.exports = {
  detectEntityTypes,
  detectProduct,
  detectFaq,
  detectContact,
  detectService,
  detectCategory,
  detectAbout,
  detectBlog,
};
