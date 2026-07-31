/**
 * Cross-encoder reranking stage, applied after RRF fusion + the existing
 * heuristic attribute reranker (utils/attributeReranker.js). This is a
 * genuine query<->document relevance model (Jina by default), which catches
 * cases the heuristic/lexical-overlap reranker misses.
 *
 * Swappable by design:
 * - To change provider, add a new file under ./providers implementing the
 *   same `rerank({ query, documents, topN, model }) -> [{ index, score }]`
 *   shape, register it in PROVIDERS below, and set RERANK_PROVIDER=<name>.
 * - To disable entirely, set RERANK_ENABLED=false (or omit the provider's
 *   API key) — callers always get back a valid match list either way.
 */

const jinaReranker = require("./providers/jinaReranker");

const PROVIDERS = {
  jina: jinaReranker,
};

const RERANK_ENABLED = process.env.RERANK_ENABLED !== "false";
const RERANK_PROVIDER = (process.env.RERANK_PROVIDER || "jina").toLowerCase();
// How many of the already rank-ordered candidates get sent to the reranker API.
// Keep this bounded — reranking is a paid/latency-costing call per request.
// Raised from 30 -> 50: the heuristic pre-sort (utils/attributeReranker.js) is
// lexical/attribute-only and can rank a genuinely relevant chunk below the old
// cutoff, which meant the cross-encoder never got a chance to see it.
const RERANK_CANDIDATE_LIMIT = Number(process.env.RERANK_CANDIDATE_LIMIT) || 50;
// Max chunks from the same URL allowed into the reranked candidate slice, so one
// heavily-chunked page can't crowd out other relevant pages before the
// cross-encoder even runs (mirrors RAG_CHATBOT's per-URL diversity filter).
const RERANK_MAX_PER_URL = Number(process.env.RERANK_MAX_PER_URL) || 3;
const RERANK_MIN_CANDIDATES = 2;
const MAX_DOC_CHARS = 4000;

function extractMatchText(match) {
  const p = match?.payload || match || {};
  const body = p.parent_text || p.text || p.pageContent || "";
  const title = p.title ? `${p.title}\n` : "";
  return `${title}${body}`.slice(0, MAX_DOC_CHARS);
}

/**
 * Picks up to `limit` candidates from an already rank-ordered list, capping how
 * many chunks from the same URL can be included so the reranker candidate pool
 * represents multiple distinct pages rather than one page's chunks dominating.
 * If the cap leaves room unused (not enough distinct URLs), backfills with the
 * next best candidates regardless of cap so the full API budget is still used.
 */
function selectDiverseCandidates(matches, limit, maxPerUrl) {
  const picked = [];
  const skipped = [];
  const perUrlCount = new Map();

  for (const match of matches) {
    if (picked.length >= limit) break;
    const url = match?.payload?.url || match?.url || "";
    const count = perUrlCount.get(url) || 0;
    if (url && count >= maxPerUrl) {
      skipped.push(match);
      continue;
    }
    perUrlCount.set(url, count + 1);
    picked.push(match);
  }

  for (const match of skipped) {
    if (picked.length >= limit) break;
    picked.push(match);
  }

  return picked;
}

/**
 * Reranks already-fused retrieval matches with a cross-encoder API.
 * Never throws — on any failure (missing key, network error, unknown
 * provider, disabled via env) it resolves with the input list unchanged so
 * the answer pipeline always has a valid fallback (the heuristic rerank
 * order from utils/attributeReranker.js).
 *
 * @param {string} query - The (already rewritten/expanded) retrieval query.
 * @param {object[]} matches - Matches already ordered by upstream rerank, each
 *   with a `payload` (or flattened) object containing text/parent_text/title.
 * @param {{ topN?: number, label?: string }} [options]
 * @returns {Promise<object[]>}
 */
async function rerankMatches(query, matches, options = {}) {
  const { topN = null, label = "hybrid" } = options;

  if (
    !RERANK_ENABLED ||
    !query ||
    !Array.isArray(matches) ||
    matches.length < RERANK_MIN_CANDIDATES
  ) {
    return matches || [];
  }

  const provider = PROVIDERS[RERANK_PROVIDER];
  if (!provider) {
    console.warn(`[Reranker] Unknown RERANK_PROVIDER "${RERANK_PROVIDER}" — skipping cross-encoder rerank`);
    return matches;
  }

  // Diversity-capped top-N heuristic-ranked candidates go to the API; anything
  // not selected stays appended at the end in its existing relative order.
  const candidates = selectDiverseCandidates(
    matches,
    RERANK_CANDIDATE_LIMIT,
    RERANK_MAX_PER_URL,
  );
  const candidateSet = new Set(candidates);
  const rest = matches.filter((m) => !candidateSet.has(m));
  const documents = candidates.map(extractMatchText);

  try {
    const results = await provider.rerank({
      query,
      documents,
      topN: topN || candidates.length,
    });

    if (!Array.isArray(results) || results.length === 0) {
      return matches;
    }

    const reordered = results
      .filter((r) => candidates[r.index] !== undefined)
      .map((r) => ({
        ...candidates[r.index],
        score: r.score,
        _crossEncoderScore: r.score,
        _preRerankScore: candidates[r.index].score,
      }));

    const returnedIndexes = new Set(results.map((r) => r.index));
    const missed = candidates.filter((_, i) => !returnedIndexes.has(i));

    const topBefore = candidates.slice(0, 5).map((m) => (m.score ?? 0).toFixed(3));
    const topAfter = reordered.slice(0, 5).map((m) => (m.score ?? 0).toFixed(3));
    console.log(
      `[Reranker] ${label} (${RERANK_PROVIDER}): ${reordered.length}/${candidates.length} reordered | top before: [${topBefore.join(", ")}] -> after: [${topAfter.join(", ")}]`,
    );

    return [...reordered, ...missed, ...rest];
  } catch (err) {
    console.warn(
      `[Reranker] ${RERANK_PROVIDER} rerank failed, falling back to heuristic order: ${err.message}`,
    );
    return matches;
  }
}

module.exports = {
  rerankMatches,
  PROVIDERS,
  RERANK_ENABLED,
  RERANK_PROVIDER,
};
