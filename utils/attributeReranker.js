/**
 * Multi-signal reranker after hybrid (dense + sparse RRF) retrieval.
 *
 * Industry pattern:
 *   finalScore = wR * normalize(RRF) + wL * lexicalOverlap + wA * attributeBoosts
 *
 * Absolute RRF scores are not comparable across queries — we min-max normalize
 * within the candidate batch, then blend with lexical and attribute signals.
 */

const SIZE_PATTERN = /\b\d{1,2}(?:-\d{1,2})?mm\b/gi;

const W_RRF = 0.5;
const W_LEXICAL = 0.3;
const W_ATTR = 0.2;

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
  const fromTerms = (p.search_terms || [])
    .filter((t) => /\dmm$/i.test(String(t)))
    .map(normalizeSize);
  const fromText = [];
  const text = payloadText(match);
  for (const m of text.matchAll(SIZE_PATTERN)) {
    fromText.push(normalizeSize(m[0]));
  }
  return [...new Set([...fromPayload, ...fromTerms, ...fromText])];
}

function payloadCollections(match) {
  const p = match.payload || match;
  const fromPayload = (p.collections || []).map((c) => c.toLowerCase());
  const text = payloadText(match);
  const hints = [];
  if (/\bsuper\s*natural\b/i.test(text)) hints.push("super natural");
  return [...new Set([...fromPayload, ...hints])];
}

function countKeywordHits(text, keywords) {
  if (!keywords?.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.length < 2) continue;
    if (text.includes(k)) hits += 1;
  }
  return hits;
}

/**
 * Lexical overlap in [0, 1]: title hits weighted higher than body.
 */
function lexicalOverlapScore(title, text, terms) {
  if (!terms?.length) return 0;
  const usable = terms
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => t.length >= 2)
    .slice(0, 16);
  if (!usable.length) return 0;

  let titleHits = 0;
  let bodyHits = 0;
  for (const term of usable) {
    if (title.includes(term)) titleHits += 1;
    else if (text.includes(term)) bodyHits += 1;
  }

  const weighted = titleHits * 2 + bodyHits;
  const maxWeighted = usable.length * 2;
  return Math.min(1, weighted / maxWeighted);
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

function urlBonus(url, subIntent, entityType) {
  const u = (url || "").toLowerCase();
  if (!u) return 0;

  let bonus = 0;

  if (
    subIntent === "IN_PAGE_LIST" &&
    (u.endsWith("/") || /\/index|\/home\b/.test(u))
  ) {
    bonus += 0.35;
  }

  if (
    subIntent === "IN_PAGE_LIST" &&
    /\/product|\/collections?\/|\/shop|\/catalog/i.test(u)
  ) {
    bonus += 0.25;
  }

  if (
    subIntent === "CONTACT_INFO" &&
    /contact|about|footer|social/i.test(u)
  ) {
    bonus += 0.35;
  }

  if (subIntent === "PAGE_LINKS" && u.length > 10) {
    bonus += 0.15;
  }

  // Catalog/collection-style questions ("what catalogs/collections do you have")
  // route to PAGE_LINKS or IN_PAGE_LIST, but the generic checks above treat every
  // URL the same regardless of what the page actually is. Use the entity_type
  // already computed at ingestion time (detectPageType.js) to favor real
  // collection/listing pages over blog posts or other content pages, which
  // otherwise win on lexical overlap alone (e.g. a blog post that happens to
  // mention "catalog" in passing).
  if (
    (subIntent === "PAGE_LINKS" || subIntent === "IN_PAGE_LIST") &&
    entityType === "listing"
  ) {
    bonus += 0.3;
  }
  if (
    (subIntent === "PAGE_LINKS" || subIntent === "IN_PAGE_LIST") &&
    entityType === "blog_post"
  ) {
    bonus -= 0.2;
  }

  // The captured site nav/mega-menu chunk (tagged entity_type="navigation" in
  // processPageDocuments.js) IS the literal answer to "what catalogs/pages do
  // you have" — it has zero lexical overlap with words like "catalog" since
  // it's just a list of collection names, so without this boost it loses to
  // unrelated content that happens to mention the word.
  if (
    (subIntent === "PAGE_LINKS" || subIntent === "IN_PAGE_LIST") &&
    entityType === "navigation"
  ) {
    bonus += 0.45;
  }

  return Math.max(-0.2, Math.min(bonus, 0.6));
}

function typePenalty(text, url, subIntent) {
  const combined = `${text} ${url}`.toLowerCase();

  if (
    subIntent === "IN_PAGE_LIST" &&
    combined.includes("footer links") &&
    !/\b(product|lash|price|\dmm)\b/i.test(combined)
  ) {
    return 0.25;
  }

  return 0;
}

/**
 * Generic soft-facet payload lookup. Checks the facet key against a few
 * conventional payload locations (top-level field, attributes.<key>,
 * search_terms) without assuming any fixed field vocabulary. Facet keys
 * that aren't indexed in the payload simply fail this lookup and fall
 * back to the text-overlap check below (and to lexical scoring elsewhere).
 */
function facetMatchesPayload(match, facet) {
  const p = match.payload || match;
  const value = facet.value;
  if (!value) return false;

  const candidates = [];
  if (p[facet.key] !== undefined) candidates.push(p[facet.key]);
  if (p.attributes && p.attributes[facet.key] !== undefined) {
    candidates.push(p.attributes[facet.key]);
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (candidate.some((v) => String(v).toLowerCase().includes(value))) {
        return true;
      }
    } else if (candidate !== null && candidate !== undefined) {
      if (String(candidate).toLowerCase().includes(value)) return true;
    }
  }
  return false;
}

/**
 * Generic soft-facet signal in [0, 1] — averaged hit rate across all soft
 * boost facets from the retrieval plan (any field, not a fixed list).
 * Payload-indexed matches count fully; text-only matches count partially
 * (lexical scoring already rewards these, so this stays a light nudge).
 */
function genericFacetScore(match, softBoosts) {
  if (!softBoosts?.length) return 0;
  const text = payloadText(match);

  let hits = 0;
  for (const facet of softBoosts) {
    if (facetMatchesPayload(match, facet)) {
      hits += 1;
    } else if (facet.value && text.includes(facet.value)) {
      hits += 0.5;
    }
  }
  return Math.min(1, hits / softBoosts.length);
}

/**
 * Attribute / structural signal in [0, 1].
 */
function attributeScore(match, attributes, subIntent, softBoosts = []) {
  const { sizes, collections, keywords } = attributes || {};
  const text = payloadText(match);
  const url = (match.payload?.url || "").toLowerCase();
  const title = (match.payload?.title || "").toLowerCase();
  const entityType = match.payload?.entity_type || null;

  const sizeMatches = sizeOverlap(sizes, payloadSizes(match));
  const collectionMatches = collectionOverlap(
    collections,
    payloadCollections(match),
  );
  const titleHits = countKeywordHits(title, keywords);
  const textHits = countKeywordHits(text, (keywords || []).slice(0, 12));
  const facetScore = genericFacetScore(match, softBoosts);

  let raw = 0;
  raw += Math.min(sizeMatches * 0.35, 0.7);
  raw += Math.min(collectionMatches * 0.3, 0.6);
  raw += Math.min(titleHits * 0.12, 0.36);
  raw += Math.min(textHits * 0.06, 0.24);
  raw += Math.min(facetScore * 0.4, 0.4);
  raw += urlBonus(url, subIntent, entityType);
  raw -= typePenalty(text, url, subIntent);

  return Math.max(0, Math.min(1, raw));
}

function minMaxNormalize(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
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
 * @param {{ subIntent?: string, lexicalTerms?: string[], softBoosts?: object[] }} [options]
 * @returns {object[]}
 */
function rerankByAttributes(candidates, attributes, options = {}) {
  if (!candidates?.length || !attributes) {
    return candidates || [];
  }

  const subIntent = options.subIntent || attributes.subIntent || null;
  const lexicalTerms =
    options.lexicalTerms?.length > 0
      ? options.lexicalTerms
      : attributes.keywords || [];
  const softBoosts = options.softBoosts || [];

  const baseScores = candidates.map((m) => m.score ?? 0);
  const normRrf = minMaxNormalize(baseScores);

  const reranked = candidates.map((match, i) => {
    const text = payloadText(match);
    const title = (match.payload?.title || "").toLowerCase();
    const rrfNorm = normRrf[i];
    const lex = lexicalOverlapScore(title, text, lexicalTerms);
    const attr = attributeScore(match, attributes, subIntent, softBoosts);

    const finalScore =
      W_RRF * rrfNorm + W_LEXICAL * lex + W_ATTR * attr;

    return {
      ...match,
      score: finalScore,
      _baseScore: baseScores[i],
      _rrfNorm: rrfNorm,
      _lexicalScore: lex,
      _attrScore: attr,
      _rerankBonus: finalScore - rrfNorm,
      _lexicalHits: Math.round(lex * (lexicalTerms.length || 1)),
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
    const lex =
      m._lexicalScore != null ? ` L${m._lexicalScore.toFixed(2)}` : "";
    const attr =
      m._attrScore != null ? ` A${m._attrScore.toFixed(2)}` : "";
    return `${(m.score ?? 0).toFixed(3)}${lex}${attr}`;
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
  lexicalOverlapScore,
  facetMatchesPayload,
  genericFacetScore,
};
