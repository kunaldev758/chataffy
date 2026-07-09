/**
 * Expands short / follow-up catalog queries using recent chat context
 * so embeddings retrieve the same products/collections across turns.
 */

const {
  normalizeQueryText,
  extractSizeTokens,
} = require("./queryNormalization");
const { isContactIntentQuestion } = require("./contactIntentDetection");

function hasCjkOrComplexScript(text) {
  return /[\u3040-\u30FF\u4E00-\u9FFF\u0900-\u097F\u0400-\u04FF]/.test(
    text || ""
  );
}

function extractCollectionHints(text) {
  const hints = new Set();
  const input = text || "";

  if (/\bsuper\s*natural\b/i.test(input)) {
    hints.add("Super Natural");
  }

  for (const m of input.matchAll(
    /\b(\d{1,2}\s*[-–]\s*\d{1,2}\s*mm)\s*(lashes?)?/gi
  )) {
    hints.add(`${m[1]} ${m[2] || "lash"}`.trim());
  }

  if (/\ball\s+lashes?\b/i.test(input)) {
    hints.add("all lashes collection");
  }

  return Array.from(hints);
}

// Multilingual signals that a user wants a product/page link rather than
// a text answer.  Each language block covers "share/send/give/show + link/url".
// NOTE: This function is intentionally kept narrow — broad product-intent
// detection now falls through to the LLM router for multilingual accuracy.
const PRODUCT_LINK_EN_RE =
  /\b(urls?|links?|link\s+to)\b/i;

const PRODUCT_LINK_EN_VERB_RE =
  /\b(share|send|give|show)\b[\s\S]{0,40}\b(url|link|options?|styles?|products?|lashes?|collection)\b/i;

// ES: comparte el enlace, dame el link
const PRODUCT_LINK_ES_RE =
  /\b(enlace|link|url|comparte|envía|dame\s+el\s+link)\b/i;

// FR: partage le lien, donne-moi le lien
const PRODUCT_LINK_FR_RE =
  /\b(lien|url|partage|envoie|donne-moi\s+le\s+lien)\b/i;

// DE: schick mir den Link, teile den Link
const PRODUCT_LINK_DE_RE =
  /\b(link|url|schick|sende|teile)\b[\s\S]{0,30}\b(link|url|produkt)\b/i;

// JA: リンクを教えて, URLを送って
const PRODUCT_LINK_JA_RE = /リンク|ＵＲＬ|url|urlを/i;

// RU: пришли ссылку, дай ссылку
const PRODUCT_LINK_RU_RE = /ссылку|ссылка|url/i;

function isProductLinkRequest(question) {
  const q = String(question || "");
  return (
    PRODUCT_LINK_EN_RE.test(q) ||
    PRODUCT_LINK_EN_VERB_RE.test(q) ||
    PRODUCT_LINK_ES_RE.test(q) ||
    PRODUCT_LINK_FR_RE.test(q) ||
    PRODUCT_LINK_DE_RE.test(q) ||
    PRODUCT_LINK_JA_RE.test(q) ||
    PRODUCT_LINK_RU_RE.test(q)
  );
}

function isEcommerceCatalogQuery(question) {
  const q = normalizeQueryText(question).toLowerCase();
  return (
    isProductLinkRequest(question) ||
    /\b\d{1,2}(?:-\d{1,2})?mm\b/.test(q) ||
    /\b(lashes?|lash|collection|catalog|products?|styles?|variants?)\b/.test(q)
  );
}

function extractTopicsFromHistory(chatMessages, limit = 8) {
  const sizes = new Set();
  const collections = new Set();
  const terms = new Set();

  const recent = (chatMessages || []).slice(-limit);
  for (const msg of recent) {
    const text = normalizeQueryText(msg.message || "");
    for (const s of extractSizeTokens(text)) sizes.add(s);
    for (const c of extractCollectionHints(text)) collections.add(c);
    if (/\b(lashes?|lash)\b/i.test(text)) terms.add("lash");
    if (/\b(collection|catalog)\b/i.test(text)) terms.add("collection");
  }

  return {
    sizes: Array.from(sizes),
    collections: Array.from(collections),
    productTerms: Array.from(terms),
  };
}

/**
 * Build a richer query string for embedding + keyword search.
 * @param {string} question - already normalized visitor message
 * @param {object[]} chatMessages
 * @param {{ sizes?: string[] }} [options]
 */
function expandQueryForRetrieval(question, chatMessages = [], options = {}) {
  const q = normalizeQueryText(question);
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const topics = extractTopicsFromHistory(chatMessages);

  const parts = [q];
  const qLower = q.toLowerCase();

  const userSizes =
    options.sizes?.length > 0 ? options.sizes : extractSizeTokens(q);
  const allSizes = [
    ...new Set([...userSizes, ...topics.sizes]),
  ];

  const historyOnlySizes = topics.sizes.filter(
    (s) => !userSizes.some((u) => u.replace(/\s/g, "") === s.replace(/\s/g, ""))
  );

  if (userSizes.length === 0 && historyOnlySizes.length > 0) {
    parts.push(...historyOnlySizes.map((s) => `${s} lash`));
  }

  if (topics.collections.length > 0) {
    parts.push(...topics.collections.slice(0, 3));
  }

  if (topics.productTerms.length > 0) {
    parts.push(...topics.productTerms);
  }

  if (isProductLinkRequest(q) && !/\b(url|link)\b/i.test(q)) {
    parts.push("product page URLs links");
  }

  const isShortFollowUp =
    wordCount <= 7 ||
    (/\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(q) && wordCount <= 10) ||
    /^(okay|ok|yes|share|more)\b/i.test(qLower);

  const hasCatalogThread =
    allSizes.length > 0 ||
    topics.collections.length > 0 ||
    (chatMessages || []).some((m) =>
      /\b(mm|lash|lashes|collection|url|link|super\s*natural)\b/i.test(
        m.message || ""
      )
    );

  let retrievalQuery = q;
  if (isShortFollowUp && hasCatalogThread && parts.length > 1) {
    retrievalQuery = [...new Set(parts)].join(" ");
  } else if (isEcommerceCatalogQuery(q) && parts.length > 1) {
    retrievalQuery = [...new Set(parts)].join(" ");
  }

  return {
    retrievalQuery,
    topics: { ...topics, sizes: allSizes },
    currentSizes: userSizes,
    wasExpanded: retrievalQuery.trim() !== q,
    wantsProductLinks: isProductLinkRequest(q),
    isCatalogQuery: isEcommerceCatalogQuery(q),
  };
}

function detectCatalogFollowUp(question, chatMessages) {
  const q = normalizeQueryText(question);
  if (!q || !chatMessages?.length) return false;

  if (isContactIntentQuestion(q)) return false;

  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (wordCount > 10) return false;

  const topics = extractTopicsFromHistory(chatMessages);
  const hasCatalogThread =
    topics.sizes.length > 0 ||
    topics.collections.length > 0 ||
    chatMessages.some((m) =>
      /\b(mm|lash|lashes|collection|super\s*natural|url|link)\b/i.test(
        m.message || ""
      )
    );

  if (!hasCatalogThread) return false;

  const hasCatalogSignalInMessage =
    /\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(q) ||
    isProductLinkRequest(q) ||
    /\b(options?|styles?|more|share|urls?|links?)\b/i.test(q);

  if (hasCatalogSignalInMessage) return true;

  // Short Latin follow-ups ("more", "yes") after a catalog thread — not bare CJK
  // messages, which are often full sentences counted as one "word".
  return !hasCjkOrComplexScript(q) && wordCount <= 5;
}

module.exports = {
  expandQueryForRetrieval,
  isProductLinkRequest,
  isEcommerceCatalogQuery,
  extractSizeTokens,
  extractTopicsFromHistory,
  extractCollectionHints,
  detectCatalogFollowUp,
};
