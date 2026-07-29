/**
 * Sparse vector encoder for Qdrant hybrid search.
 *
 * Uses BM25-style term frequency saturation (k1, b) with hashed feature
 * indices. This encoder intentionally emits the BM25-TF component only;
 * Qdrant's `idf` sparse-vector modifier applies collection-level IDF during
 * retrieval and maintains corpus statistics as points change.
 *
 * Query-time: pass lexicalTerms in boost to up-weight intent-layer tokens.
 */

const VOCAB_SIZE = 1 << 20; // ~1M buckets

/** BM25 parameters (Robertson / Sparck Jones defaults) */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Typical chunk length in tokens for length normalization */
const AVG_DOC_LEN = 180;

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
 * BM25 TF component (no IDF): tf * (k1+1) / (tf + k1 * (1-b+b*dl/avgdl))
 */
function bm25Tf(tf, docLen, avgDl = AVG_DOC_LEN) {
  if (tf <= 0) return 0;
  const lengthNorm = 1 - BM25_B + BM25_B * (docLen / Math.max(avgDl, 1));
  return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
}

/**
 * Build sparse vector { indices, values } for Qdrant.
 * @param {string} text - primary text (child chunk; no embed prefix)
 * @param {{
 *   title?: string,
 *   sku?: string,
 *   url?: string,
 *   lexicalTerms?: string[],
 * }} boost - extra lexical signals
 */
function encodeSparseVector(text, boost = {}) {
  const lexicalExtra = Array.isArray(boost.lexicalTerms)
    ? boost.lexicalTerms.filter(Boolean).join(" ")
    : "";

  const parts = [
    boost.title || "",
    boost.sku ? `sku ${boost.sku}` : "",
    boost.url || "",
    lexicalExtra,
    text || "",
  ];
  const combined = parts.filter(Boolean).join(" ");

  const tokens = tokenize(combined);
  const docLen = Math.max(tokens.length, 1);

  // Raw term frequencies
  const tfMap = new Map();
  const addRaw = (token, count = 1) => {
    if (!token || token.length < 2) return;
    tfMap.set(token, (tfMap.get(token) || 0) + count);
  };

  for (const token of tokens) {
    addRaw(token, 1);
  }

  // Phrase bigrams from consecutive tokens (helps "super natural", "size 8")
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    addRaw(bigram, 1);
  }

  // Explicit multi-word lexical terms from intent layer
  for (const term of boost.lexicalTerms || []) {
    const t = String(term || "")
      .toLowerCase()
      .trim();
    if (t.length < 2) continue;
    const partsOfTerm = tokenize(t);
    if (partsOfTerm.length >= 2) {
      addRaw(partsOfTerm.join("_"), 3);
    }
    for (const p of partsOfTerm) {
      addRaw(p, 2);
    }
  }

  // Boost exact codes (SKUs, model numbers)
  for (const code of extractCodes(combined)) {
    addRaw(code, 3);
    const compact = code.replace(/[-_.]/g, "");
    if (compact !== code && compact.length >= 3) {
      addRaw(compact, 2);
    }
  }

  if (tfMap.size === 0) {
    return { indices: [], values: [] };
  }

  // Hash to buckets, sum BM25-TF weights (collision-safe accumulate)
  const bucketWeights = new Map();
  for (const [token, tf] of tfMap) {
    const weight = bm25Tf(tf, docLen);
    if (weight <= 0) continue;
    const idx = hashToken(token);
    bucketWeights.set(idx, (bucketWeights.get(idx) || 0) + weight);
  }

  const indices = [];
  const values = [];
  for (const [idx, weight] of bucketWeights) {
    indices.push(idx);
    values.push(weight);
  }

  return { indices, values };
}

module.exports = {
  encodeSparseVector,
  hashToken,
  tokenize,
  extractCodes,
  bm25Tf,
  VOCAB_SIZE,
  BM25_K1,
  BM25_B,
  AVG_DOC_LEN,
};
