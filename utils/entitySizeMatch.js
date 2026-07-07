/**
 * Shared size matching for entity attributes and retrieval filtering.
 */

const SIZE_TOKEN = /\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*mm\b/gi;

function normalizeSizeToken(s) {
  return (s || "").replace(/\s/g, "").toLowerCase();
}

function parseSizesFromText(text) {
  const sizes = new Set();
  const input = text || "";

  for (const m of input.matchAll(SIZE_TOKEN)) {
    const low = parseInt(m[1], 10);
    const high = m[2] ? parseInt(m[2], 10) : low;
    if (!Number.isFinite(low)) continue;
    sizes.add(`${low}mm`);
    if (high !== low && Number.isFinite(high)) {
      sizes.add(`${low}-${high}mm`);
      sizes.add(`${high}mm`);
    }
  }

  return Array.from(sizes);
}

function sizeBoundsFromList(sizes = []) {
  let min = null;
  let max = null;

  for (const raw of sizes) {
    const norm = normalizeSizeToken(raw);
    const range = norm.match(/^(\d{1,2})-(\d{1,2})mm$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      min = min === null ? a : Math.min(min, a);
      max = max === null ? b : Math.max(max, b);
      continue;
    }
    const single = norm.match(/^(\d{1,2})mm$/);
    if (single) {
      const n = parseInt(single[1], 10);
      min = min === null ? n : Math.min(min, n);
      max = max === null ? n : Math.max(max, n);
    }
  }

  return { size_min: min, size_max: max };
}

function querySizeMatchesBounds(querySize, sizeMin, sizeMax) {
  const norm = normalizeSizeToken(querySize);
  const range = norm.match(/^(\d{1,2})(?:-(\d{1,2}))?mm$/);
  if (!range) return false;

  const qLow = parseInt(range[1], 10);
  const qHigh = range[2] ? parseInt(range[2], 10) : qLow;

  if (sizeMin == null || sizeMax == null) return false;
  return qLow <= sizeMax && qHigh >= sizeMin;
}

/**
 * @param {string[]} querySizes - e.g. ["10mm"]
 * @param {{ sizes?: string[], size_min?: number|null, size_max?: number|null }} attributes
 */
function querySizesMatchAttributes(querySizes, attributes = {}) {
  if (!querySizes?.length) return true;

  const attrSizes = attributes.sizes || [];
  let { size_min: sizeMin, size_max: sizeMax } = attributes;

  if ((sizeMin == null || sizeMax == null) && attrSizes.length > 0) {
    const bounds = sizeBoundsFromList(attrSizes);
    sizeMin = bounds.size_min;
    sizeMax = bounds.size_max;
  }

  for (const qs of querySizes) {
    const qNorm = normalizeSizeToken(qs);
    if (attrSizes.some((s) => normalizeSizeToken(s) === qNorm)) return true;
    if (querySizeMatchesBounds(qs, sizeMin, sizeMax)) return true;
  }

  return false;
}

function extractPriceFromText(text) {
  const m = (text || "").match(
    /(?:\$|€|£)\s*([\d,]+(?:\.\d{2})?)|([\d,]+(?:\.\d{2})?)\s*(?:USD|EUR|GBP)/i,
  );
  if (!m) return null;
  const raw = (m[1] || m[2] || "").replace(/,/g, "");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function extractCurrencyFromText(text) {
  if (/\$|USD/i.test(text || "")) return "USD";
  if (/€|EUR/i.test(text || "")) return "EUR";
  if (/£|GBP/i.test(text || "")) return "GBP";
  return null;
}

module.exports = {
  normalizeSizeToken,
  parseSizesFromText,
  sizeBoundsFromList,
  querySizeMatchesBounds,
  querySizesMatchAttributes,
  extractPriceFromText,
  extractCurrencyFromText,
};
