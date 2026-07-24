/**
 * Progressive metadata-aware reranking on top of vector/keyword scores.
 * Aligns with content-pipeline payloads: entity_type, pageType, attributes,
 * classification_confidence, quality_score.
 *
 * Prefer PDP (entity_type=product, /products/) for product-detail intents
 * and PLP (entity_type=listing, /collections/) for catalog intents.
 */

const {
  rerankByAttributes,
  payloadSizes,
  sizeOverlap,
} = require("../../utils/attributeReranker");

function payloadOf(match) {
  return match?.payload || match || {};
}

/**
 * Ordered boost: 1st preferred > 2nd > soft.
 * Prevents listing and product from getting the same +0.12.
 */
function entityBoost(entityType, strategy = {}) {
  const soft = strategy.softEntityTypes || [];
  const preferred = strategy.preferredEntityTypes || [];
  const et = String(entityType || "general").toLowerCase();
  const primary = strategy.primaryEntity
    ? String(strategy.primaryEntity).toLowerCase()
    : preferred[0] || null;

  if (primary && et === primary) return 0.18;
  const prefIdx = preferred.indexOf(et);
  if (prefIdx === 0) return 0.18;
  if (prefIdx === 1) return 0.06;
  if (prefIdx > 1) return 0.03;
  if (soft.includes(et)) return 0.04;

  // Penalize the wrong commerce peer when we have a clear primary
  if (primary === "product" && et === "listing") return -0.1;
  if (primary === "listing" && et === "product") return -0.04;

  if (et === "general") return -0.02;
  return 0;
}

function pageTypeBoost(pageType, strategy = {}) {
  const preferred = strategy.preferredPageTypes || [];
  const pt = String(pageType || "").toLowerCase();
  if (preferred.includes(pt)) return 0.04;
  return 0;
}

/**
 * URL path signals: /products/ ↔ PDP, /collections/ ↔ PLP.
 */
function urlPathBoost(url, strategy = {}) {
  const u = String(url || "").toLowerCase();
  if (!u) return 0;

  const primary = strategy.primaryEntity
    ? String(strategy.primaryEntity).toLowerCase()
    : strategy.preferredEntityTypes?.[0] || null;

  const isPdpPath = /\/products?\/|\/p\/|\/item\/|\/sku\//i.test(u);
  const isPlpPath =
    /\/collections?\/|\/category\/|\/categories\/|\/catalog\//i.test(u);

  if (primary === "product") {
    if (isPdpPath) return 0.14;
    if (isPlpPath) return -0.12;
  }
  if (primary === "listing" || strategy.mode === "catalog_list") {
    if (isPlpPath) return 0.14;
    if (isPdpPath) return -0.04;
  }
  if (strategy.mode === "page_links") {
    if (isPlpPath) return 0.1;
    if (isPdpPath) return 0.06;
  }
  return 0;
}

/**
 * Prefer entity_name / title overlap with query tokens for PDP questions.
 */
function nameMatchBoost(match, queryAttributes = {}, strategy = {}) {
  if (strategy.primaryEntity !== "product") return 0;

  const p = payloadOf(match);
  const name = String(p.entity_name || p.title || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ");
  if (!name || name.length < 3) return 0;

  const q = String(
    queryAttributes.normalizedQuestion ||
      queryAttributes.retrievalQuery ||
      queryAttributes.keywordSource ||
      "",
  ).toLowerCase();

  const keywords = (queryAttributes.keywords || [])
    .map((k) => String(k).toLowerCase())
    .filter((k) => k.length > 2)
    .slice(0, 10);

  let hits = 0;
  for (const kw of keywords) {
    if (name.includes(kw)) hits += 1;
  }
  // Also check significant query words in name
  for (const w of q.split(/\s+/)) {
    if (w.length > 3 && name.includes(w)) hits += 1;
  }

  if (hits >= 2) return 0.1;
  if (hits === 1) return 0.05;
  return 0;
}

function attributeSoftBoost(match, queryAttributes = {}, strategy = {}) {
  const p = payloadOf(match);
  const attrs =
    p.attributes && typeof p.attributes === "object" ? p.attributes : {};
  let bonus = 0;

  const querySizes =
    queryAttributes.sizes || strategy.attributeHardFilters?.sizes || [];
  if (querySizes.length) {
    const docSizes = [
      ...payloadSizes(match),
      ...[].concat(attrs.sizes || []).map((s) => String(s).toLowerCase()),
    ];
    const overlap = sizeOverlap(querySizes, docSizes);
    bonus += Math.min(overlap * 0.1, 0.2);
  }

  const productUrls = attrs.product_urls || [];
  if (
    (strategy.mode === "catalog_list" || strategy.mode === "page_links") &&
    productUrls.length > 0
  ) {
    bonus += Math.min(0.02 + productUrls.length * 0.005, 0.1);
  }

  // PDP structured commerce attrs
  if (strategy.primaryEntity === "product") {
    if (attrs.price != null || attrs.sku) bonus += 0.05;
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

  const baseReranked = rerankByAttributes(candidates, queryAttributes, {
    subIntent: options.subIntent || queryAttributes?.subIntent || null,
  });

  const scored = baseReranked.map((match) => {
    const p = payloadOf(match);
    const base = match.score ?? 0;
    let meta = 0;
    meta += entityBoost(p.entity_type, strategy);
    meta += pageTypeBoost(p.pageType, strategy);
    meta += urlPathBoost(p.url, strategy);
    meta += nameMatchBoost(match, queryAttributes, strategy);
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
  urlPathBoost,
  nameMatchBoost,
  qualityConfidenceBoost,
};
