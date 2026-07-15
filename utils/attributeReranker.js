/**
 * Rule-based attribute-aware re-ranking after hybrid retrieval merge.
 */

const SIZE_PATTERN = /\b\d{1,2}(?:-\d{1,2})?mm\b/gi;

function normalizeSize(s) {
  return (s || "").replace(/\s/g, "").toLowerCase();
}

function payloadText(match) {
  const p = match.payload || match;
  return `${p.title || ""} ${p.url || ""} ${p.text || ""}`.toLowerCase();
}

function payloadSizes(match) {
  const p = match.payload || match;
  const fromPayload = (p.sizes || []).map(normalizeSize);
  const fromAttrs = Array.isArray(p.attributes?.sizes)
    ? p.attributes.sizes.map(normalizeSize)
    : [];
  const fromTerms = (p.search_terms || [])
    .filter((t) => /\dmm$/i.test(String(t)))
    .map(normalizeSize);
  const fromText = [];
  const text = payloadText(match);
  for (const m of text.matchAll(SIZE_PATTERN)) {
    fromText.push(normalizeSize(m[0]));
  }
  return [...new Set([...fromPayload, ...fromAttrs, ...fromTerms, ...fromText])];
}

function payloadCollections(match) {
  const p = match.payload || match;
  const fromPayload = (p.collections || []).map((c) => c.toLowerCase());
  const fromAttrs = Array.isArray(p.attributes?.collections)
    ? p.attributes.collections.map((c) => String(c).toLowerCase())
    : [];
  const text = payloadText(match);
  const hints = [];
  if (/\bsuper\s*natural\b/i.test(text)) hints.push("super natural");
  return [...new Set([...fromPayload, ...fromAttrs, ...hints])];
}

function countKeywordHits(text, keywords) {
  if (!keywords?.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.length < 3) continue;
    if (text.includes(k)) hits += 1;
  }
  return hits;
}

function sizeOverlap(querySizes, docSizes) {
  if (!querySizes?.length || !docSizes?.length) return 0;
  const qSet = new Set(querySizes.map(normalizeSize));
  let matches = 0;
  for (const ds of docSizes) {
    const norm = normalizeSize(ds);
    if (qSet.has(norm)) {
      matches += 1;
      continue;
    }
    for (const qs of qSet) {
      if (norm.includes(qs) || qs.includes(norm)) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

function collectionOverlap(queryCollections, docCollections) {
  if (!queryCollections?.length || !docCollections?.length) return 0;
  const qLower = queryCollections.map((c) => c.toLowerCase());
  let matches = 0;
  for (const dc of docCollections) {
    const d = dc.toLowerCase();
    if (qLower.some((q) => d.includes(q) || q.includes(d))) matches += 1;
  }
  return matches;
}

function urlBonus(url, attributes, subIntent) {
  const u = (url || "").toLowerCase();
  if (!u) return 0;

  let bonus = 0;
  const { flags } = attributes || {};

  if (flags?.wantsHomepage && (u.endsWith("/") || /\/index|\/home\b/.test(u))) {
    bonus += 0.12;
  }

  if (
    (flags?.isCatalogQuery ||
      flags?.wantsProductLinks ||
      subIntent === "IN_PAGE_LIST") &&
    /\/product|\/collections?\/|\/shop|\/catalog/i.test(u)
  ) {
    bonus += 0.08;
  }

  if (
    (flags?.wantsContact || subIntent === "CONTACT_INFO") &&
    /contact|about|footer|social/i.test(u)
  ) {
    bonus += 0.1;
  }

  if (subIntent === "PAGE_LINKS" && u.length > 10) {
    bonus += 0.04;
  }

  return bonus;
}

function typePenalty(text, url, attributes, subIntent) {
  const combined = `${text} ${url}`.toLowerCase();
  const { flags } = attributes || {};

  if (
    (flags?.isCatalogQuery || subIntent === "IN_PAGE_LIST") &&
    !flags?.wantsContact &&
    combined.includes("footer links") &&
    !/\b(product|lash|price|\dmm)\b/i.test(combined)
  ) {
    return 0.08;
  }

  return 0;
}

/**
 * True when chunk text/title/url mentions a requested size (incl. ranges like 16-18mm).
 */
function matchContainsQuerySize(match, querySizes) {
  if (!querySizes?.length) return true;

  const docSizes = payloadSizes(match);
  if (sizeOverlap(querySizes, docSizes) > 0) return true;

  const text = payloadText(match);
  for (const qs of querySizes) {
    const norm = normalizeSize(qs);
    if (!norm) continue;
    if (text.includes(norm)) return true;

    const num = norm.replace(/mm$/i, "");
    if (num && new RegExp(`\\b${num}\\s*[-–]?\\s*\\d{0,2}\\s*mm\\b`, "i").test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Keep only chunks matching requested sizes. Falls back to input if filter is empty.
 */
function filterMatchesBySizes(matches, querySizes, { strict = false } = {}) {
  if (!querySizes?.length) return matches || [];
  const filtered = (matches || []).filter((m) =>
    matchContainsQuerySize(m, querySizes)
  );
  if (filtered.length > 0) return filtered;
  return strict ? [] : matches || [];
}

/**
 * @param {object[]} candidates - merged retrieval matches
 * @param {object} attributes - from extractQueryAttributes()
 * @param {{ subIntent?: string }} [options]
 * @returns {object[]}
 */
function rerankByAttributes(candidates, attributes, options = {}) {
  if (!candidates?.length || !attributes) {
    return candidates || [];
  }

  const subIntent = options.subIntent || attributes.subIntent || null;
  const { sizes, collections, keywords } = attributes;

  let routeBias = "semantic";
  if (subIntent === "IN_PAGE_LIST" || attributes.flags?.isCatalogQuery) {
    routeBias = "catalog";
  } else if (subIntent === "CONTACT_INFO" || attributes.flags?.wantsContact) {
    routeBias = "contact";
  }

  const { entityTypeBoost } = require("./retrievalConfidence");

  const reranked = candidates.map((match) => {
    const baseScore = match.score ?? 0;
    const text = payloadText(match);
    const url = (match.payload?.url || "").toLowerCase();
    const title = (match.payload?.title || "").toLowerCase();

    const docSizes = payloadSizes(match);
    const docCollections = payloadCollections(match);

    const sizeMatches = sizeOverlap(sizes, docSizes);
    const collectionMatches = collectionOverlap(collections, docCollections);
    const titleHits = countKeywordHits(title, keywords);
    const textHits = countKeywordHits(text, keywords.slice(0, 12));

    let bonus = 0;
    bonus += Math.min(sizeMatches * 0.15, 0.3);
    bonus += Math.min(collectionMatches * 0.12, 0.24);
    bonus += Math.min(titleHits * 0.06, 0.18);
    bonus += Math.min(textHits * 0.03, 0.12);
    bonus += urlBonus(url, attributes, subIntent);
    bonus -= typePenalty(text, url, attributes, subIntent);
    bonus += entityTypeBoost(match.payload?.entity_type, routeBias);

    // Prefer higher ingest confidence slightly when scores are close
    const conf = match.payload?.classification_confidence;
    if (typeof conf === "number") {
      bonus += (conf - 0.5) * 0.04;
    }

    const rerankScore = baseScore + bonus;

    return {
      ...match,
      score: rerankScore,
      _baseScore: baseScore,
      _rerankBonus: bonus,
    };
  });

  return reranked.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function logRerankStats(label, before, after, limit = 5) {
  if (!after?.length) return;

  const topBefore = (before || [])
    .slice(0, limit)
    .map((m) => (m.score ?? 0).toFixed(3));
  const topAfter = after.slice(0, limit).map((m) => {
    const bonus =
      m._rerankBonus != null ? `+${m._rerankBonus.toFixed(3)}` : "";
    return `${(m.score ?? 0).toFixed(3)}${bonus}`;
  });

  console.log(
    `[Rerank] ${label} | top ${limit} before: [${topBefore.join(", ")}] → after: [${topAfter.join(", ")}]`
  );
}

module.exports = {
  rerankByAttributes,
  logRerankStats,
  filterMatchesBySizes,
  matchContainsQuerySize,
  payloadSizes,
  sizeOverlap,
};
