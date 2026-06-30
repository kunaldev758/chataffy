/**
 * Normalizes visitor queries and expands morphology (lash/lashes) for retrieval.
 * Raw question is kept for chat display; normalized form is used for routing/search.
 */

const MORPHOLOGY_ROOTS = new Set([
  "lash",
  "product",
  "item",
  "style",
  "collection",
  "catalog",
  "variant",
]);

function extractSizeTokens(text) {
  const sizes = new Set();
  const input = text || "";

  for (const m of input.matchAll(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*mm\b/gi)) {
    sizes.add(`${m[1]}-${m[2]}mm`);
    sizes.add(`${m[1]}mm`);
    sizes.add(`${m[2]}mm`);
  }
  for (const m of input.matchAll(/\b(\d{1,2})\s*mm\b/gi)) {
    sizes.add(`${m[1]}mm`);
  }
  return Array.from(sizes);
}

function normalizeQueryText(raw) {
  let q = (raw || "").trim().replace(/\s+/g, " ");
  if (!q) return "";

  q = q.replace(/[\u2013\u2014]/g, "-");
  q = q.replace(/\b(\d{1,2})\s*m{2,}\b/gi, (_, n) => `${n}mm`);
  q = q.replace(/\b(\d{1,2})\s*-\s*(\d{1,2})\s*mm\b/gi, "$1-$2mm");
  q = q.replace(/\b(\d{1,2})\s+mm\b/gi, "$1mm");

  return q;
}

function simpleSingular(word) {
  const w = (word || "").toLowerCase();
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ses") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

function simplePlural(word) {
  const w = (word || "").toLowerCase();
  if (w.endsWith("y") && w.length > 2 && !/[aeiou]y$/i.test(w)) {
    return `${w.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (w.endsWith("s")) return w;
  return `${w}s`;
}

function isMorphologyRoot(word) {
  const w = (word || "").toLowerCase();
  const sing = simpleSingular(w);
  return MORPHOLOGY_ROOTS.has(w) || MORPHOLOGY_ROOTS.has(sing);
}

function expandMorphologyForTerm(term) {
  const t = (term || "").toLowerCase().trim();
  if (!t) return [];

  const variants = new Set([t]);
  if (!isMorphologyRoot(t)) return [t];

  const sing = simpleSingular(t);
  const plur = simplePlural(sing);
  variants.add(sing);
  variants.add(plur);

  return Array.from(variants);
}

function expandMorphologyForTerms(terms) {
  const expanded = new Set();
  for (const term of terms || []) {
    for (const v of expandMorphologyForTerm(term)) {
      if (v.length > 1) expanded.add(v);
    }
  }
  return Array.from(expanded);
}

function detectMorphologyHints(text) {
  const q = (text || "").toLowerCase();
  const hints = new Set();

  for (const root of MORPHOLOGY_ROOTS) {
    const plur = simplePlural(root);
    const pattern = new RegExp(`\\b(${root}|${plur})\\b`, "i");
    if (pattern.test(q)) {
      hints.add(root);
      hints.add(plur);
    }
  }

  return Array.from(hints);
}

const RETRIEVAL_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "all",
  "show",
  "list",
  "give",
  "me",
  "how",
  "your",
  "our",
  "my",
  "what",
  "when",
  "where",
  "have",
  "get",
  "can",
  "could",
  "would",
  "will",
  "that",
  "this",
  "from",
  "about",
  "only",
  "just",
]);

function tokenizeForKeywords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !RETRIEVAL_STOP_WORDS.has(w));
}

/**
 * Build keyword list for structural Qdrant scroll (OR match).
 */
function buildRetrievalKeywords(query, sizes = []) {
  const tokens = tokenizeForKeywords(query);
  const sizeKeywords = (sizes || []).flatMap((s) => {
    const normalized = s.replace(/\s/g, "");
    const numOnly = normalized.replace(/mm$/i, "");
    return [normalized, numOnly].filter((k) => k.length > 2);
  });

  const morphology = expandMorphologyForTerms([
    ...tokens,
    ...detectMorphologyHints(query),
  ]);

  return [
    ...new Set([...tokens, ...sizeKeywords, ...morphology]),
  ].filter((k) => k.length > 2);
}

/**
 * Append morphology variants to a retrieval string for embedding search.
 */
function enrichRetrievalQueryForEmbedding(retrievalQuery, sizes = []) {
  const hints = detectMorphologyHints(retrievalQuery);
  const sizeHints = (sizes || []).map((s) => s.replace(/\s/g, ""));
  const extra = expandMorphologyForTerms([...hints, ...sizeHints]);
  const parts = [retrievalQuery, ...extra.filter((t) => !retrievalQuery.includes(t))];
  return [...new Set(parts.join(" ").split(/\s+/))].join(" ");
}

function normalizeUserQuery(rawQuestion) {
  const raw = (rawQuestion || "").trim();
  const normalized = normalizeQueryText(raw);
  const sizes = extractSizeTokens(normalized);
  const morphologyHints = detectMorphologyHints(normalized);
  const retrievalKeywords = buildRetrievalKeywords(normalized, sizes);

  return {
    raw,
    normalized,
    sizes,
    morphologyHints,
    retrievalKeywords,
    enrichForEmbedding: (retrievalQuery) =>
      enrichRetrievalQueryForEmbedding(retrievalQuery || normalized, sizes),
  };
}

function hasSizedCatalogIntent(normalizedQuestion, sizes = []) {
  const q = (normalizedQuestion || "").toLowerCase();
  const hasSize =
    (sizes && sizes.length > 0) || /\b\d{1,2}(?:-\d{1,2})?mm\b/.test(q);
  const hasCatalog =
    /\b(lash(?:es)?|product|style|collection|catalog)\b/i.test(q);
  return hasSize && hasCatalog;
}

function sizeMatchNeedles(sizes) {
  const needles = new Set();
  for (const s of sizes || []) {
    const compact = s.replace(/\s/g, "").toLowerCase();
    const num = compact.replace(/mm$/i, "");
    needles.add(compact);
    if (num) {
      needles.add(num);
      needles.add(`${num} mm`);
    }
  }
  return Array.from(needles);
}

function filterMatchesBySizes(matches, sizes) {
  if (!sizes?.length) return matches || [];
  const needles = sizeMatchNeedles(sizes);
  const filtered = (matches || []).filter((m) => {
    const payload = m.payload || {};
    const hay = [
      payload.title,
      payload.url,
      payload.text,
      ...(payload.search_terms || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
  return filtered.length > 0 ? filtered : matches || [];
}

/** Regex fragment: product/catalog nouns including lash + lashes */
const CATALOG_PRODUCT_WORDS =
  "(?:products?|items?|options?|styles?|lash(?:es)?)";

module.exports = {
  normalizeQueryText,
  extractSizeTokens,
  expandMorphologyForTerm,
  expandMorphologyForTerms,
  buildRetrievalKeywords,
  enrichRetrievalQueryForEmbedding,
  normalizeUserQuery,
  hasSizedCatalogIntent,
  sizeMatchNeedles,
  filterMatchesBySizes,
  MORPHOLOGY_ROOTS,
  CATALOG_PRODUCT_WORDS,
};
