const crypto = require("crypto");

/**
 * Normalize a URL for stable product identity (strip query/hash, trailing slash).
 */
function normalizeProductUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return String(url).trim() || null;
  }
}

/**
 * Walk JSON-LD for product identifiers (@id, sku, productID, mpn).
 */
function extractIdsFromJsonLd(jsonLdBlocks = []) {
  const ids = { sku: null, mpn: null, productId: null, atId: null };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const types = []
      .concat(node["@type"] || [])
      .map((t) =>
        String(t || "")
          .toLowerCase()
          .replace(/^https?:\/\/schema\.org\//, "")
          .trim(),
      );
    const isProduct = types.some((t) =>
      ["product", "productgroup", "individualproduct"].includes(t),
    );
    if (isProduct || types.includes("offer")) {
      if (!ids.sku && node.sku) ids.sku = String(node.sku).trim();
      if (!ids.mpn && node.mpn) ids.mpn = String(node.mpn).trim();
      if (!ids.productId && node.productID)
        ids.productId = String(node.productID).trim();
      if (!ids.atId && node["@id"]) ids.atId = String(node["@id"]).trim();
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  };

  for (const block of jsonLdBlocks || []) {
    walk(block);
  }
  return ids;
}

/**
 * Resolve a stable product_id for grouping chunks of one product.
 * Priority: explicit attrs → JSON-LD sku/mpn/@id → canonical URL → page URL → name hash.
 *
 * @returns {string|null}
 */
function resolveProductId({
  url = "",
  canonicalUrl = null,
  attributes = {},
  entity_name = null,
  entity_type = null,
  jsonLdBlocks = [],
  html = null,
} = {}) {
  if (entity_type !== "product") return null;

  const attrs = attributes && typeof attributes === "object" ? attributes : {};
  if (attrs.product_id) return String(attrs.product_id).trim();

  const fromLd = extractIdsFromJsonLd(jsonLdBlocks);
  if (fromLd.sku) return `sku:${fromLd.sku}`;
  if (attrs.sku) return `sku:${String(attrs.sku).trim()}`;
  if (fromLd.mpn) return `mpn:${fromLd.mpn}`;
  if (attrs.mpn) return `mpn:${String(attrs.mpn).trim()}`;
  if (fromLd.productId) return `pid:${fromLd.productId}`;
  if (fromLd.atId) {
    const normalized = normalizeProductUrl(fromLd.atId);
    if (normalized) return `url:${normalized}`;
    return `id:${fromLd.atId.slice(0, 120)}`;
  }

  // DOM data-product-id fallback
  if (html && typeof html === "string") {
    const m = html.match(/data-product-id=["']([^"']+)["']/i);
    if (m?.[1]) return `pid:${m[1].trim()}`;
  }

  const canon = canonicalUrl ? normalizeProductUrl(canonicalUrl) : null;
  if (canon) return `url:${canon}`;

  const pageUrl = normalizeProductUrl(url);
  if (pageUrl) return `url:${pageUrl}`;

  if (entity_name) {
    const h = crypto
      .createHash("sha256")
      .update(String(entity_name).trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return `name:${h}`;
  }

  return null;
}

module.exports = {
  resolveProductId,
  normalizeProductUrl,
  extractIdsFromJsonLd,
};
