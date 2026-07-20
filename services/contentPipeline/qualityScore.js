/**
 * Cheap heuristic quality score for normalized page markdown (Phase 2).
 * Returns 0–1; below QUALITY_THRESHOLD → skip embed.
 */

const QUALITY_THRESHOLD = 0.35;

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
};
