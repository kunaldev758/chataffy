/**
 * Retrieval-time threshold adjustment from ingest classification_confidence.
 * Lower ingest confidence → require a stronger vector match before trusting the chunk.
 */

const CONFIDENCE_PENALTY_K = Number(
  process.env.RETRIEVAL_CONFIDENCE_PENALTY_K || 0.2,
);

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Per-match effective score threshold.
 * @param {number} baseThreshold
 * @param {object} [payload]
 */
function thresholdForPayload(baseThreshold, payload = {}) {
  const conf = clamp01(payload?.classification_confidence);
  if (conf == null) return baseThreshold;
  return baseThreshold + (1 - conf) * CONFIDENCE_PENALTY_K;
}

/**
 * Filter matches with confidence-aware thresholds.
 */
function filterByConfidenceAwareThreshold(matches, baseThreshold) {
  if (!Array.isArray(matches)) return [];
  return matches.filter((m) => {
    const needed = thresholdForPayload(baseThreshold, m.payload || m);
    return (m.score ?? 0) >= needed;
  });
}

/**
 * Soft boost for entity types that align with the active retrieval route.
 */
function entityTypeBoost(entityType, routeBias) {
  const t = String(entityType || "").toLowerCase();
  if (!routeBias || !t) return 0;
  if (routeBias === "catalog" && (t === "product" || t === "listing")) return 0.08;
  if (routeBias === "contact" && (t === "about" || t === "faq")) return 0.06;
  if (
    routeBias === "semantic" &&
    (t === "faq" || t === "docs" || t === "policy" || t === "blog_post")
  ) {
    return 0.04;
  }
  // Prefer non-general when asking catalog questions
  if (routeBias === "catalog" && t === "general") return -0.03;
  return 0;
}

module.exports = {
  CONFIDENCE_PENALTY_K,
  thresholdForPayload,
  filterByConfidenceAwareThreshold,
  entityTypeBoost,
};
