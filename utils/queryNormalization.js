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

// English function words
const EN_STOP_WORDS = [
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with",
  "all", "show", "list", "give", "me", "how", "your", "our", "my", "what",
  "when", "where", "have", "get", "can", "could", "would", "will", "that",
  "this", "from", "about", "only", "just", "its", "is", "are", "was", "be",
  "do", "does", "did",
];

// Spanish function words
const ES_STOP_WORDS = [
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del",
  "en", "con", "por", "para", "que", "qué", "es", "son", "está", "están",
  "yo", "me", "mi", "tu", "su", "se", "le", "lo", "quiero", "dame",
  "muéstrame", "dime",
];

// French function words
const FR_STOP_WORDS = [
  "le", "la", "les", "un", "une", "des", "du", "de", "en", "au", "aux",
  "et", "ou", "que", "qui", "je", "tu", "il", "elle", "nous", "vous",
  "me", "mon", "ma", "mes", "son", "sa", "ses", "est", "sont", "avec",
  "pour", "sur", "dans", "montrez", "dites", "donnez",
];

// German function words
const DE_STOP_WORDS = [
  "der", "die", "das", "ein", "eine", "einen", "dem", "den", "des",
  "und", "oder", "ist", "sind", "ich", "du", "er", "sie", "wir", "ihr",
  "mit", "von", "für", "auf", "in", "bei", "nach", "zeige", "zeigen",
  "gib", "mir", "mein", "meine",
];

// Portuguese function words
const PT_STOP_WORDS = [
  "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das",
  "em", "no", "na", "e", "ou", "que", "eu", "me", "meu", "minha",
  "você", "seu", "sua", "com", "para", "por", "mostre", "me", "diga",
];

// Italian function words
const IT_STOP_WORDS = [
  "il", "lo", "la", "i", "gli", "le", "un", "una", "di", "del", "della",
  "dei", "degli", "delle", "e", "o", "che", "io", "mi", "mio", "mia",
  "tu", "lui", "lei", "noi", "voi", "con", "per", "su", "mostra",
  "dimmi", "dammi",
];

const RETRIEVAL_STOP_WORDS = new Set([
  ...EN_STOP_WORDS,
  ...ES_STOP_WORDS,
  ...FR_STOP_WORDS,
  ...DE_STOP_WORDS,
  ...PT_STOP_WORDS,
  ...IT_STOP_WORDS,
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

module.exports = {
  normalizeQueryText,
  extractSizeTokens,
  expandMorphologyForTerm,
  expandMorphologyForTerms,
  buildRetrievalKeywords,
  enrichRetrievalQueryForEmbedding,
  normalizeUserQuery,
  MORPHOLOGY_ROOTS,
};
