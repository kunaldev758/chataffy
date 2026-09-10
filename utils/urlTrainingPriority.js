const { isHomepageUrl } = require("./webUrlUtils");

/**
 * Score URLs so large sitemaps train useful pages first (home, FAQ, policies)
 * instead of a random dump of product/tag URLs.
 * Higher score = train sooner / keep when capping discovery.
 */
const PRIORITY_RULES = [
  {
    name: "faq",
    score: 920,
    re: /\/(faq|faqs|help|support|customer-service|knowledge-base|kb)(\/|$)/i,
  },
  {
    name: "contact",
    score: 900,
    re: /\/(contact|contact-us|contacts|get-in-touch)(\/|$)/i,
  },
  {
    name: "shipping_returns",
    score: 880,
    re: /\/(shipping|delivery|returns?|refunds?|exchanges?|warranty)(\/|$)/i,
  },
  {
    name: "about",
    score: 860,
    re: /\/(about|about-us|our-story|company|team)(\/|$)/i,
  },
  {
    name: "policy",
    score: 840,
    re: /\/(privacy|privacy-policy|terms|terms-of-service|tos|legal|policy|policies)(\/|$)/i,
  },
  {
    name: "pricing",
    score: 800,
    re: /\/(pricing|plans?|subscriptions?|rates?)(\/|$)/i,
  },
  {
    name: "docs",
    score: 760,
    re: /\/(docs?|documentation|developers?|guides?|reference)(\/|$)/i,
  },
  {
    name: "listing",
    score: 620,
    re: /\/(collections?|category|categories|catalog|shop)(\/|$)/i,
  },
  {
    name: "product",
    score: 420,
    re: /\/(products?|p|item|sku|dp)\//i,
  },
  {
    name: "blog",
    score: 360,
    re: /\/(blog|news|articles?|posts?|insights)(\/|$)/i,
  },
];

const LOW_VALUE_RE =
  /\/(tagged|tags?|author|authors|print|share|filter)(\/|$)/i;

function pathDepth(pathname) {
  return String(pathname || "/")
    .split("/")
    .filter(Boolean).length;
}

function scoreUrlForTraining(url) {
  if (!url || typeof url !== "string") return 0;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || "/";

    if (isHomepageUrl(url)) return 1000;
    if (LOW_VALUE_RE.test(pathname)) return 80;

    let score = 300;
    for (const rule of PRIORITY_RULES) {
      if (rule.re.test(pathname)) {
        score = rule.score;
        break;
      }
    }

    // Prefer shallow pages (category over nested filter URLs).
    score -= Math.min(40, Math.max(0, pathDepth(pathname) - 1) * 8);

    const queryCount = [...parsed.searchParams.keys()].length;
    if (queryCount > 0) score -= Math.min(50, queryCount * 12);

    return score;
  } catch {
    return 0;
  }
}

function sortUrlsForTraining(urls) {
  if (!Array.isArray(urls) || urls.length < 2) {
    return Array.isArray(urls) ? [...urls] : [];
  }

  return [...urls].sort((a, b) => {
    const diff = scoreUrlForTraining(b) - scoreUrlForTraining(a);
    if (diff !== 0) return diff;
    return String(a).localeCompare(String(b));
  });
}

module.exports = {
  scoreUrlForTraining,
  sortUrlsForTraining,
  PRIORITY_RULES,
};
