/**
 * Lightweight sparse vector encoder for Qdrant hybrid search.
 * Uses hashed token indices + log-TF weights (BM25-like, no corpus IDF).
 * Same encoder used at ingest and query time.
 */

const VOCAB_SIZE = 1 << 20; // ~1M buckets

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "your",
  "our",
  "this",
  "that",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "will",
  "http",
  "https",
  "www",
  "com",
  "html",
  "page",
]);

function hashToken(token) {
  let h = 2166136261;
  const s = String(token);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) % VOCAB_SIZE;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Extract alphanumeric codes (SKU, model numbers, serials).
 */
function extractCodes(text) {
  const raw = String(text || "");
  const matches = raw.match(/\b[A-Za-z0-9][A-Za-z0-9_.-]{2,}\b/g) || [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/**
 * Build sparse vector { indices, values } for Qdrant.
 * @param {string} text - primary text (child chunk; no embed prefix)
 * @param {{ title?: string, sku?: string, url?: string }} boost - extra lexical signals
 */
function encodeSparseVector(text, boost = {}) {
  const parts = [
    boost.title || "",
    boost.sku ? `sku ${boost.sku}` : "",
    boost.url || "",
    text || "",
  ];
  const combined = parts.filter(Boolean).join(" ");

  const bucketWeights = new Map();

  const addToken = (token, weight = 1) => {
    if (!token || token.length < 2) return;
    const idx = hashToken(token);
    bucketWeights.set(idx, (bucketWeights.get(idx) || 0) + weight);
  };

  for (const token of tokenize(combined)) {
    addToken(token, 1);
  }

  // Boost exact codes (SKUs, model numbers) for lexical recall
  for (const code of extractCodes(combined)) {
    addToken(code, 3);
    // Also add code without separators for variants like ABC-123 vs ABC123
    const compact = code.replace(/[-_.]/g, "");
    if (compact !== code && compact.length >= 3) {
      addToken(compact, 2);
    }
  }

  if (bucketWeights.size === 0) {
    return { indices: [], values: [] };
  }

  const indices = [];
  const values = [];
  for (const [idx, weight] of bucketWeights) {
    indices.push(idx);
    values.push(1 + Math.log(weight));
  }

  return { indices, values };
}

module.exports = {
  encodeSparseVector,
  hashToken,
  tokenize,
  extractCodes,
  VOCAB_SIZE,
};
