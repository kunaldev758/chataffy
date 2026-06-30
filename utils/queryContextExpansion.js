/**
 * Expands short / follow-up catalog queries using recent chat context
 * so embeddings retrieve the same products/collections across turns.
 */

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

function isProductLinkRequest(question) {
  const q = (question || "").toLowerCase();
  return (
    /\b(urls?|links?)\b/.test(q) ||
    /\b(link\s+to)\b/.test(q) ||
    (/\b(share|send|give|show)\b/.test(q) &&
      /\b(url|link|options?|styles?|products?|lashes?|collection)\b/.test(q))
  );
}

function isEcommerceCatalogQuery(question) {
  const q = (question || "").toLowerCase();
  return (
    isProductLinkRequest(question) ||
    /\b\d{1,2}\s*mm\b/.test(q) ||
    /\b(lashes?|lash|collection|catalog|products?|styles?|variants?)\b/.test(q)
  );
}

function extractTopicsFromHistory(chatMessages, limit = 8) {
  const sizes = new Set();
  const collections = new Set();
  const terms = new Set();

  const recent = (chatMessages || []).slice(-limit);
  for (const msg of recent) {
    const text = msg.message || "";
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
 */
function expandQueryForRetrieval(question, chatMessages = []) {
  const q = (question || "").trim();
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const topics = extractTopicsFromHistory(chatMessages);

  const parts = [q];
  const qLower = q.toLowerCase();

  const userSizes = extractSizeTokens(q);
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
    (/\b\d{1,2}\s*mm\b/i.test(q) && wordCount <= 10) ||
    /^(okay|ok|yes|share|more)\b/i.test(qLower);

  const hasCatalogThread =
    topics.sizes.length > 0 ||
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
    topics,
    wasExpanded: retrievalQuery.trim() !== q,
    wantsProductLinks: isProductLinkRequest(q),
    isCatalogQuery: isEcommerceCatalogQuery(q),
  };
}

function detectCatalogFollowUp(question, chatMessages) {
  const q = (question || "").trim();
  if (!q || !chatMessages?.length) return false;
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

  return (
    /\b\d{1,2}\s*mm\b/i.test(q) ||
    isProductLinkRequest(q) ||
    /\b(options?|styles?|more|share|urls?|links?)\b/i.test(q) ||
    wordCount <= 5
  );
}

module.exports = {
  expandQueryForRetrieval,
  isProductLinkRequest,
  isEcommerceCatalogQuery,
  extractSizeTokens,
  extractTopicsFromHistory,
  detectCatalogFollowUp,
};
