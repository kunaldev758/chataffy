/**
 * Extract search_terms for Qdrant payload at index time (per-chunk vocabulary).
 */

const {
  extractSizeTokens,
  expandMorphologyForTerms,
  MORPHOLOGY_ROOTS,
} = require("./queryNormalization");

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
  "http",
  "https",
  "www",
  "com",
  "html",
  "page",
]);

function slugTokens(url) {
  if (!url || typeof url !== "string") return [];
  try {
    const pathname = new URL(url).pathname;
    return pathname
      .split(/[/\-_]+/)
      .map((s) => s.toLowerCase().trim())
      .filter((s) => s.length > 2 && !STOP_WORDS.has(s));
  } catch {
    return url
      .split(/[/\-_]+/)
      .map((s) => s.toLowerCase().trim())
      .filter((s) => s.length > 2 && !STOP_WORDS.has(s));
  }
}

function titleTokens(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * @param {{ text?: string, title?: string, url?: string }} fields
 * @returns {string[]}
 */
function extractSearchTerms({ text = "", title = "", url = "" } = {}) {
  const combined = `${title} ${url} ${text}`;
  const terms = new Set();

  for (const size of extractSizeTokens(combined)) {
    terms.add(size.toLowerCase());
    const numOnly = size.replace(/mm$/i, "");
    if (numOnly.length > 1) terms.add(numOnly);
  }

  for (const token of [...titleTokens(title), ...slugTokens(url)]) {
    terms.add(token);
  }

  const words = combined
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  for (const word of words) {
    terms.add(word);
  }

  for (const root of MORPHOLOGY_ROOTS) {
    if (combined.toLowerCase().includes(root)) {
      for (const v of expandMorphologyForTerms([root])) {
        terms.add(v);
      }
    }
  }

  return Array.from(terms).slice(0, 80);
}

/**
 * Structured attributes for Qdrant payload (re-ranking + filtering).
 * @param {{ text?: string, title?: string, url?: string, source_type?: string }} fields
 */
function extractPayloadAttributes({ text = "", title = "", url = "", source_type } = {}) {
  const combined = `${title} ${url} ${text}`;
  const sizes = extractSizeTokens(combined).map((s) =>
    s.replace(/\s/g, "").toLowerCase()
  );

  const collections = [];
  if (/\bsuper\s*natural\b/i.test(combined)) {
    collections.push("Super Natural");
  }

  const urlLower = (url || "").toLowerCase();
  let inferredType = source_type || "page";
  if (/\/products?\/|\/collections?\/|\/shop\b|\/catalog\b/i.test(urlLower)) {
    inferredType = "product";
  } else if (
    /contact|about-us|about\b|footer/i.test(urlLower) ||
    /footer\s+links/i.test(combined)
  ) {
    inferredType = "contact";
  }

  return {
    sizes: [...new Set(sizes)],
    collections: [...new Set(collections)],
    source_type: inferredType,
  };
}

module.exports = {
  extractSearchTerms,
  extractPayloadAttributes,
};
