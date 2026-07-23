/**
 * Retrieval confidence evaluation + decision to broaden/retry.
 */

const { entityTypeMix } = require("./contextDiversity");

/**
 * @param {object[]} matches
 * @param {object} strategy
 * @returns {{ high: boolean, score: number, reasons: string[], metrics: object }}
 */
function evaluateRetrievalConfidence(matches = [], strategy = {}) {
  const reasons = [];
  const top = matches[0];
  const topScore = top?.score ?? 0;
  const topSemantic = top?._baseScore ?? topScore;
  const mix = entityTypeMix(matches);
  const typeCount = Object.keys(mix).length;

  let score = 0;

  if (topScore >= 0.55) {
    score += 0.35;
    reasons.push("strong_top_score");
  } else if (topScore >= 0.4) {
    score += 0.2;
    reasons.push("moderate_top_score");
  } else if (topScore >= 0.28) {
    score += 0.1;
    reasons.push("weak_top_score");
  } else {
    reasons.push("very_weak_top_score");
  }

  if (matches.length >= 4) {
    score += 0.2;
    reasons.push("enough_matches");
  } else if (matches.length >= 2) {
    score += 0.1;
    reasons.push("few_matches");
  } else if (matches.length === 1) {
    score += 0.05;
    reasons.push("single_match");
  } else {
    reasons.push("no_matches");
  }

  const p = top?.payload || {};
  if (typeof p.quality_score === "number" && p.quality_score >= 0.6) {
    score += 0.15;
    reasons.push("good_quality");
  }
  if (
    typeof p.classification_confidence === "number" &&
    p.classification_confidence >= 0.7
  ) {
    score += 0.1;
    reasons.push("confident_classification");
  }

  const preferred =
    strategy.preferredEntityTypes || strategy.softEntityTypes || [];
  if (preferred.length && matches.length) {
    const hitPreferred = matches.some((m) =>
      preferred.includes(
        String(m.payload?.entity_type || "general").toLowerCase(),
      ),
    );
    if (hitPreferred) {
      score += 0.15;
      reasons.push("preferred_entity_present");
    } else {
      reasons.push("preferred_entity_missing");
    }
  }

  if (typeCount >= 2) {
    score += 0.05;
    reasons.push("diverse_entities");
  }

  const high = matches.length > 0 && score >= 0.45 && topScore >= 0.28;

  return {
    high,
    score: Math.min(1, score),
    reasons,
    metrics: {
      topScore,
      topSemantic,
      matchCount: matches.length,
      entityMix: mix,
      strategyReason: strategy.reason || null,
      broadened: Boolean(strategy.broadened),
    },
  };
}

module.exports = {
  evaluateRetrievalConfidence,
};
