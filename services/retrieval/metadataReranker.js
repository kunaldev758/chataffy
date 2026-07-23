/**
 * Progressive metadata-aware reranking on top of vector/keyword scores.
 * Aligns with content-pipeline payloads: entity_type, pageType, attributes,
 * classification_confidence, quality_score.
 */

const {
  rerankByAttributes,
  payloadSizes,
  sizeOverlap,
} = require("../../utils/attributeReranker");

function payloadOf(match) {
  return match?.payload || match || {};
}

function entityBoost(entityType, strategy = {}) {
  const soft = strategy.softEntityTypes || [];
  const preferred = strategy.preferredEntityTypes || [];
  const et = String(entityType || "general").toLowerCase();

  if (preferred.includes(et)) return 0.12;
  if (soft.includes(et)) return 0.06;
  if (et === "general") return -0.02;
  return 0;
}

function pageTypeBoost(pageType, strategy = {}) {
  const preferred = strategy.preferredPageTypes || [];
  const pt = String(pageType || "").toLowerCase();
  if (preferred.includes(pt)) return 0.05;
  return 0;
}

function attributeSoftBoost(match, queryAttributes = {}, strategy = {}) {
  const p = payloadOf(match);
  const attrs =
    p.attributes && typeof p.attributes === "object" ? p.attributes : {};
  let bonus = 0;

  const querySizes = queryAttributes.sizes || strategy.attributeHardFilters?.sizes || [];
  if (querySizes.length) {
    const docSizes = [
      ...payloadSizes(match),
      ...[].concat(attrs.sizes || []).map((s) => String(s).toLowerCase()),
    ];
    const overlap = sizeOverlap(querySizes, docSizes);
    bonus += Math.min(overlap * 0.1, 0.2);
  }

  // Product URL richness for catalog intents
  const productUrls = attrs.product_urls || [];
  if (
    (strategy.mode === "catalog_list" || strategy.mode === "page_links") &&
    productUrls.length > 0
  ) {
    bonus += Math.min(0.02 + productUrls.length * 0.005, 0.1);
  }

  return bonus;
}

function qualityConfidenceBoost(match) {
  const p = payloadOf(match);
  let bonus = 0;
  if (typeof p.quality_score === "number") {
    bonus += Math.min(Math.max(p.quality_score - 0.5, 0) * 0.1, 0.08);
  }
  if (typeof p.classification_confidence === "number") {
    bonus += Math.min(p.classification_confidence * 0.06, 0.06);
  }
  // Soft penalty for unresolved residual
  if (
    typeof p.classification_confidence === "number" &&
    p.classification_confidence < 0.4
  ) {
    bonus -= 0.04;
  }
  return bonus;
}

/**
 * @param {object[]} candidates
 * @param {object} queryAttributes
 * @param {object} strategy
 * @param {{ subIntent?: string }} [options]
 */
function rerankWithMetadata(
  candidates,
  queryAttributes,
  strategy = {},
  options = {},
) {
  if (!candidates?.length) return [];

  // First: existing attribute/keyword rerank
  const baseReranked = rerankByAttributes(candidates, queryAttributes, {
    subIntent: options.subIntent || queryAttributes?.subIntent || null,
  });

  const scored = baseReranked.map((match) => {
    const p = payloadOf(match);
    const base = match.score ?? 0;
    let meta = 0;
    meta += entityBoost(p.entity_type, strategy);
    meta += pageTypeBoost(p.pageType, strategy);
    meta += attributeSoftBoost(match, queryAttributes, strategy);
    meta += qualityConfidenceBoost(match);

    return {
      ...match,
      score: base + meta,
      _baseScore: match._baseScore ?? base,
      _rerankBonus: (match._rerankBonus || 0) + meta,
      _metaBonus: meta,
    };
  });

  return scored.sort((a, b) => (b.score || 0) - (a.score || 0));
}

module.exports = {
  rerankWithMetadata,
  entityBoost,
  qualityConfidenceBoost,
};
