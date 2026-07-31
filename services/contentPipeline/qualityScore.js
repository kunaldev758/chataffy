/**
 * Cheap heuristic quality score for normalized page markdown (Phase 2).
 * Returns 0–1; below QUALITY_THRESHOLD → skip embed.
 */

const QUALITY_THRESHOLD = 0.35;

/**
 * Utility/account URL paths that are never useful RAG content, even if the
 * rendered page happens to contain enough words to pass the heuristic score
 * (e.g. a cart page listing product names). Checked once per URL, before any
 * per-section scoring, so we don't waste an LLM/extraction pass on them.
 */
const EXCLUDED_URL_PATTERNS = [
  /\/cart(\/|$|\?)/i,
  /\/checkout(\/|$|\?)/i,
  /\/account(\/|$|\?)/i,
  /\/(login|signin|sign-in)(\/|$|\?)/i,
  /\/(register|signup|sign-up)(\/|$|\?)/i,
  /\/search(\/|$|\?)/i,
  /\/wishlist(\/|$|\?)/i,
  /\/(order|orders)(\/|$|\?)/i,
  /sitemap[^/]*\.xml(\?|$)/i,
];

/**
 * Explicit soft-404 / HTTP-error page signals. These are deterministic hard
 * fails checked against page title + a leading content sample, independent
 * of (and stricter than) the heuristic BOILERPLATE_PHRASES score below —
 * a page that literally says "404 - Page Not Found" should never be trained
 * on regardless of how many other words happen to be on it (nav, footer...).
 */
const SOFT_404_PATTERNS = [
  /404\s*[-—:]?\s*page\s*not\s*found/i,
  /\bpage\s*not\s*found\b/i,
  /\b403\s*forbidden\b/i,
  /\baccess\s*denied\b/i,
  /\b500\s*internal\s*server\s*error\b/i,
  /\bservice\s*unavailable\b/i,
  /the\s*requested\s*url\s*was\s*not\s*found/i,
  /this\s*domain\s*is\s*parked/i,
  /\bsite\s*(?:is\s*)?under\s*maintenance\b/i,
];

/**
 * @param {string} url
 * @returns {boolean} true when the URL matches a known non-content utility path.
 */
function isExcludedUtilityUrl(url = "") {
  const u = String(url || "");
  if (!u) return false;
  return EXCLUDED_URL_PATTERNS.some((re) => re.test(u));
}

/**
 * @param {string} text - page title + leading content sample
 * @returns {boolean} true when the text is a soft-404 / HTTP error page.
 */
function isSoft404Content(text = "") {
  const sample = String(text || "");
  if (!sample.trim()) return false;
  return SOFT_404_PATTERNS.some((re) => re.test(sample));
}

const BOILERPLATE_PHRASES = [
  "accept cookies",
  "cookie policy",
  "we use cookies",
  "enable javascript",
  "please enable cookies",
  "sign in to continue",
  "captcha",
  "access denied",
  "403 forbidden",
  "404 not found",
  "page not found",
];

function scoreQuality(text, { title = "" } = {}) {
  const raw = String(text || "").trim();
  const reasons = [];

  if (!raw) {
    return { score: 0, pass: false, reasons: ["empty"] };
  }

  const chars = raw.length;
  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const linkCount = (raw.match(/https?:\/\//gi) || []).length;
  const headingCount = (raw.match(/^#{1,6}\s+/gm) || []).length;
  const lower = raw.toLowerCase();

  let score = 0.5;

  // Length signal
  if (chars < 80) {
    score -= 0.45;
    reasons.push("too_short");
  } else if (chars < 200) {
    score -= 0.25;
    reasons.push("short");
  } else if (chars >= 400) {
    score += 0.15;
  } else if (chars >= 250) {
    score += 0.08;
  }

  if (wordCount >= 80) score += 0.1;
  else if (wordCount < 25) {
    score -= 0.2;
    reasons.push("few_words");
  }

  // Link-heavy / thin pages
  if (wordCount > 0) {
    const linkDensity = linkCount / wordCount;
    if (linkDensity > 0.35 && chars < 800) {
      score -= 0.3;
      reasons.push("link_heavy");
    } else if (linkDensity > 0.2 && wordCount < 40) {
      score -= 0.2;
      reasons.push("link_dense_thin");
    }
  }

  // Boilerplate
  let boilerplateHits = 0;
  for (const phrase of BOILERPLATE_PHRASES) {
    if (lower.includes(phrase)) boilerplateHits += 1;
  }
  if (boilerplateHits >= 2 && chars < 600) {
    score -= 0.35;
    reasons.push("boilerplate");
  } else if (boilerplateHits >= 1 && chars < 200) {
    score -= 0.2;
    reasons.push("boilerplate_short");
  }

  // Structure bonus
  if (headingCount >= 1) score += 0.05;
  if (headingCount >= 3) score += 0.05;
  if (title && title.length > 3 && title !== raw.slice(0, title.length)) {
    score += 0.05;
  }

  score = Math.max(0, Math.min(1, score));
  const pass = score >= QUALITY_THRESHOLD;

  if (!pass && reasons.length === 0) reasons.push("below_threshold");

  return { score: Number(score.toFixed(3)), pass, reasons };
}

module.exports = {
  scoreQuality,
  QUALITY_THRESHOLD,
  isExcludedUtilityUrl,
  isSoft404Content,
  EXCLUDED_URL_PATTERNS,
  SOFT_404_PATTERNS,
};
