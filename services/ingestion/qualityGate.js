/**
 * Stage C & D: Quality Gates (Pass/Fail Checks).
 * Evaluates whether normalized text meets quality standards for RAG indexing.
 *
 * options.mode:
 *   - "strict" (default): full test-backend gates (webpages)
 *   - "lenient": only empty-body check (snippets / files / FAQs — preserve product behavior)
 *
 * options.preferEntityType / preferPageType:
 *   When the extract pipeline already classified a structured product listing,
 *   use a lower word minimum so valid 1-product PLPs (e.g. brand pages) train.
 */

const SOFT_404_PATTERNS = [
  /404\s*-\s*page\s*not\s*found/i,
  /page\s*not\s*found/i,
  /403\s*forbidden/i,
  /access\s*denied/i,
  /500\s*internal\s*server\s*error/i,
  /service\s*unavailable/i,
  /the\s*requested\s*url\s*was\s*not\s*found/i,
  /this\s*domain\s*is\s*parked/i,
  /under\s*maintenance/i,
];

 /**
 * Utility path segments skipped on any site.
 * Match is exact segment only, so /order-fulfillment and /search-engine-marketing
 * are not treated as /order or /search.
 */
const EXCLUDED_PATH_SEGMENTS = new Set([
  "cart",
  "checkout",
  "account",
  "login",
  "register",
  "search",
  "wishlist",
  "order",
  "orders",
]);

function getUrlPathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    const withoutHash = String(url).split("#")[0];
    const withoutQuery = withoutHash.split("?")[0];
    const schemeIdx = withoutQuery.indexOf("://");
    if (schemeIdx === -1) return withoutQuery;
    const afterHost = withoutQuery.slice(schemeIdx + 3);
    const slash = afterHost.indexOf("/");
    return slash === -1 ? "/" : afterHost.slice(slash);
  }
}

function findExcludedPathSegment(url) {
  const pathname = getUrlPathname(url);
  const segments = pathname.split("/").filter(Boolean);
  for (const raw of segments) {
    const base = raw.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
    if (base.includes("sitemap")) return raw;
    if (EXCLUDED_PATH_SEGMENTS.has(base)) return raw;
  }
  return null;
}

/** Default webpage body minimum (strict). */
const DEFAULT_MIN_WORDS = 30;

/**
 * Structured listing extracts (dom_listing) are intentionally compact:
 * title + collection URL + one ## Product block can be ~25–35 words.
 * Allow these when extract pipeline already marked listing/product.
 */
const STRUCTURED_LISTING_MIN_WORDS = 15;

/**
 * True when markdown looks like listingToMarkdown output with ≥1 real product.
 */
function hasStructuredListingProduct(rawText = "") {
  const text = String(rawText || "");
  if (!text.trim()) return false;
  if (/_No products extracted\._/i.test(text)) return false;
  // listingToMarkdown shape: ## Product + Name: + (Price: or Product URL:)
  const hasProductHeading = /##\s*Product\b/i.test(text);
  const hasName = /Name:\s*\n\s*\S+/i.test(text);
  const hasCommerceField =
    /Price:\s*\n\s*\S+/i.test(text) ||
    /Product URL:\s*\n\s*https?:\/\//i.test(text) ||
    /Availability:\s*\n\s*\S+/i.test(text);
  return hasProductHeading && hasName && hasCommerceField;
}

function resolveMinWordCount(normalizedData, options = {}) {
  const entity = String(
    options.preferEntityType || options.entity_type || "",
  ).toLowerCase();
  const pageType = String(
    options.preferPageType || options.pageType || "",
  ).toLowerCase();
  const rawText = normalizedData?.rawText || "";

  const extractSaysListing =
    entity === "listing" ||
    (pageType === "product" && entity === "listing");
  const extractSaysProduct =
    pageType === "product" || entity === "product" || entity === "listing";

  if (
    extractSaysProduct &&
    (extractSaysListing || entity === "product") &&
    hasStructuredListingProduct(rawText)
  ) {
    return STRUCTURED_LISTING_MIN_WORDS;
  }

  // Also accept structured listing markdown even if prefer* missing
  // (defensive) — still require the listing shape so random short pages fail.
  if (hasStructuredListingProduct(rawText) && /Collection URL:/i.test(rawText)) {
    return STRUCTURED_LISTING_MIN_WORDS;
  }

  return DEFAULT_MIN_WORDS;
}

function checkQualityGates(normalizedData, options = {}) {
  const { rawText, metrics, pageTitle, url } = normalizedData;
  const mode = options.mode === "lenient" ? "lenient" : "strict";

  // 1. Empty content check (always)
  if (!rawText || !rawText.trim()) {
    return {
      pass: false,
      reason: "Empty page body text",
      metrics,
    };
  }

  if (mode === "lenient") {
    return {
      pass: true,
      reason: null,
      metrics,
    };
  }

  // 0. Excluded URL path-segment check (sitemaps, cart, utility pages)
  if (url && !String(url).startsWith("local://")) {
    const excludedSegment = findExcludedPathSegment(url);
    if (excludedSegment) {
      return {
        pass: false,
        reason: `Excluded utility or sitemap URL pattern (/${excludedSegment})`,
        metrics,
      };
    }
  }

  // 2. Minimum word count threshold
  const minWords = resolveMinWordCount(normalizedData, options);
  if (metrics.wordCount < minWords) {
    return {
      pass: false,
      reason: `Low word count (${metrics.wordCount} words < ${minWords} threshold)`,
      metrics,
      minWords,
    };
  }

  // 3. Soft-404 & HTTP Error page detection
  const combinedStr = `${pageTitle}\n${rawText.slice(0, 1000)}`;
  for (const pattern of SOFT_404_PATTERNS) {
    if (pattern.test(combinedStr)) {
      return {
        pass: false,
        reason: `Soft-404 or HTTP error page detected (${pattern.toString()})`,
        metrics,
      };
    }
  }

  return {
    pass: true,
    reason: null,
    metrics,
    minWords,
  };
}

module.exports = {
  checkQualityGates,
  SOFT_404_PATTERNS,
  EXCLUDED_PATH_SEGMENTS,
  findExcludedPathSegment,
  DEFAULT_MIN_WORDS,
  STRUCTURED_LISTING_MIN_WORDS,
  hasStructuredListingProduct,
  resolveMinWordCount,
};
