/**
 * Context diversity: avoid a single entity_type dominating the top-K.
 */

function payloadOf(m) {
  return m?.payload || m || {};
}

/**
 * Round-robin across entity types while preserving score order within each type.
 * @param {object[]} rankedMatches - already score-sorted
 * @param {{ limit?: number, minTypes?: number }} [options]
 */
function selectDiverseMatches(rankedMatches = [], options = {}) {
  const limit = options.limit ?? 12;
  const minTypes = options.minTypes ?? 2;

  if (!rankedMatches.length) return [];
  if (rankedMatches.length <= limit) return rankedMatches.slice(0, limit);

  const byType = new Map();
  for (const m of rankedMatches) {
    const et = String(payloadOf(m).entity_type || "general").toLowerCase();
    if (!byType.has(et)) byType.set(et, []);
    byType.get(et).push(m);
  }

  // If only one type, just truncate
  if (byType.size < minTypes) {
    return rankedMatches.slice(0, limit);
  }

  const types = [...byType.keys()].sort((a, b) => {
    const scoreA = byType.get(a)[0]?.score ?? 0;
    const scoreB = byType.get(b)[0]?.score ?? 0;
    return scoreB - scoreA;
  });

  const pointers = Object.fromEntries(types.map((t) => [t, 0]));
  const selected = [];
  const seen = new Set();

  // First pass: one from each type
  for (const t of types) {
    if (selected.length >= limit) break;
    const list = byType.get(t);
    const idx = pointers[t];
    if (idx < list.length) {
      const m = list[idx];
      const id = m.id || `${payloadOf(m).url}:${payloadOf(m).chunk_index}`;
      if (!seen.has(id)) {
        seen.add(id);
        selected.push(m);
      }
      pointers[t] += 1;
    }
  }

  // Fill remaining by global score order
  for (const m of rankedMatches) {
    if (selected.length >= limit) break;
    const id = m.id || `${payloadOf(m).url}:${payloadOf(m).chunk_index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(m);
  }

  return selected;
}

/**
 * Summarize entity mix for logging / confidence.
 */
function entityTypeMix(matches = []) {
  const counts = {};
  for (const m of matches) {
    const et = String(payloadOf(m).entity_type || "general").toLowerCase();
    counts[et] = (counts[et] || 0) + 1;
  }
  return counts;
}

module.exports = {
  selectDiverseMatches,
  entityTypeMix,
};
