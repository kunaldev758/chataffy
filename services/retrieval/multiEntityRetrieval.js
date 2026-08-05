/**
 * Multi-Entity Retrieval Orchestrator
 * -----------------------------------
 * For comparison / multi-ask queries:
 *   1. Run the FULL hybrid retrieval path once per entity (in parallel)
 *   2. Keep topK_per_entity from each side (balanced — not global topK)
 *   3. Interleave results so neither entity dominates the LLM context
 *   4. Optionally build a larger, labeled context string for the answer step
 *
 * Why per-entity retrieval?
 *   A single embedding of "A vs B" biases toward one product. Separate searches
 *   give each entity a fair candidate pool.
 *
 * This module does NOT know about Qdrant — the caller injects `runEntityRetrieval`.
 *
 * Env:
 *   RAG_COMPARE_TOPK_PER_ENTITY=5   (chunks kept per entity after its own retrieval)
 *   RAG_COMPARE_MAX_MATCHES=16      (hard cap after interleave)
 *   RAG_MAX_CONTEXT_CHARS_COMPARE=8000
 */

/**
 * @typedef {Object} EntityRetrievalBucket
 * @property {string} entity
 * @property {Array<object>} matches
 */

/**
 * Defaults for compare / multi-ask retrieval depth.
 * @returns {{ topKPerEntity: number, maxTotalMatches: number, maxContextChars: number }}
 */
function getMultiEntityRetrievalDefaults() {
  return {
    topKPerEntity: Math.max(
      2,
      Number(process.env.RAG_COMPARE_TOPK_PER_ENTITY) || 8,
    ),
    maxTotalMatches: Math.max(
      4,
      Number(process.env.RAG_COMPARE_MAX_MATCHES) || 16,
    ),
    maxContextChars: Math.max(
      4000,
      Number(process.env.RAG_MAX_CONTEXT_CHARS_COMPARE) || 12000,
    ),
  };
}

/**
 * Interleave per-entity match lists so context stays balanced.
 * Round-robin: [A1, B1, A2, B2, ...] with dedupe by point id.
 *
 * @param {EntityRetrievalBucket[]} buckets
 * @param {number} maxTotal
 * @returns {Array<object>}
 */
function interleaveEntityMatches(buckets = [], maxTotal = 16) {
  const candidateMap = new Map();
  const lists = buckets.map((b) => b.matches || []);
  const maxLen = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < lists.length; j++) {
      const item = lists[j][i];
      if (!item) continue;
      const id = item.id != null ? String(item.id) : `idx-${j}-${i}`;
      if (candidateMap.has(id)) continue;

      const entity = buckets[j]?.entity || "";
      // Tag payload so context builders / debugging know which entity this hit was for.
      candidateMap.set(id, {
        ...item,
        payload: {
          ...(item.payload || {}),
          comparison_entity: entity,
        },
        comparison_entity: entity,
      });

      if (candidateMap.size >= maxTotal) {
        return Array.from(candidateMap.values());
      }
    }
  }

  return Array.from(candidateMap.values());
}

/**
 * Strip HTML lightly for compare context blocks.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlLite(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a larger, entity-labeled context for comparison / multi-ask answers.
 * Groups chunks under each entity heading so the LLM can cover both sides.
 *
 * @param {EntityRetrievalBucket[]} buckets - per-entity top matches (pre-interleave ok)
 * @param {object} [options]
 * @param {number} [options.maxTotalChars]
 * @param {number} [options.maxChunkChars]
 * @param {boolean} [options.isComparison]
 * @returns {string}
 */
function buildMultiEntityContext(buckets = [], options = {}) {
  const maxTotalChars =
    options.maxTotalChars || getMultiEntityRetrievalDefaults().maxContextChars;
  const maxChunkChars = options.maxChunkChars || 1500;
  const mode = options.multiEntityMode;
  const isComparison =
    Boolean(options.isComparison) || mode === "compare";
  const isChoose = mode === "choose_from_list";

  let header;
  if (isChoose) {
    header =
      "The user is asking for help choosing between the products listed below. Use ONLY the knowledge-base sections. Recommend based on differences (price, size, features, use case). If you need more user preferences, ask one short clarifying question.\n";
  } else if (isComparison) {
    header =
      "The user asked to COMPARE the following products/entities. Use ONLY the knowledge-base sections below. Cover each entity fairly (price, features, sizes, links when present). Do not invent missing products.\n";
  } else {
    header =
      "The user asked about MULTIPLE products/entities in one question. Answer each using the matching section below. Do not invent missing products.\n";
  }

  const blocks = [header];
  let totalChars = header.length;

  for (const bucket of buckets) {
    const entity = bucket.entity || "Item";
    const sectionHeader = `\n=== Entity: ${entity} ===\n`;
    if (totalChars + sectionHeader.length > maxTotalChars) break;

    blocks.push(sectionHeader);
    totalChars += sectionHeader.length;

    const matches = bucket.matches || [];
    for (const match of matches) {
      const payload = match.payload || {};
      let text = stripHtmlLite(
        payload.parent_text || payload.text || payload.pageContent || "",
      );
      if (!text) continue;
      if (text.length > maxChunkChars) {
        text = `${text.slice(0, maxChunkChars)}…`;
      }

      const url = payload.url || "";
      const title = payload.title || url || entity;
      const block = url
        ? `Source: ${title} (${url})\n---\n${text}\n---\n`
        : `${text}\n---\n`;

      if (totalChars + block.length > maxTotalChars) {
        const remaining = maxTotalChars - totalChars;
        if (remaining > 200) {
          blocks.push(block.slice(0, remaining) + "…\n");
        }
        return blocks.join("");
      }

      blocks.push(block);
      totalChars += block.length;
    }
  }

  return blocks.join("");
}

/**
 * Run full retrieval once per entity, take topK each, interleave for the LLM.
 *
 * @param {object} params
 * @param {string[]} params.entities - detected entity names (length >= 2)
 * @param {boolean} [params.isComparison]
 * @param {number} [params.topKPerEntity]
 * @param {number} [params.maxTotalMatches]
 * @param {(entity: string, index: number) => Promise<Array<object>>} params.runEntityRetrieval
 *   Caller supplies the existing hybrid retrieval path for one entity query.
 * @returns {Promise<{
 *   matches: Array<object>,
 *   buckets: EntityRetrievalBucket[],
 *   prebuiltContext: string,
 *   isComparison: boolean,
 *   maxContextChars: number,
 * }>}
 */
async function runMultiEntityRetrieval({
  entities = [],
  entityPlans = null,
  isComparison = false,
  multiEntityMode = null,
  topKPerEntity,
  maxTotalMatches,
  runEntityRetrieval,
} = {}) {
  const defaults = getMultiEntityRetrievalDefaults();
  const perEntityK = topKPerEntity || defaults.topKPerEntity;
  const maxTotal = maxTotalMatches || defaults.maxTotalMatches;

  // Accept EntityPlan[] or legacy string[] entity names.
  const entityInputs =
    Array.isArray(entityPlans) && entityPlans.length >= 2
      ? entityPlans
      : (entities || []).map((name) => ({ name: String(name) }));

  if (entityInputs.length < 2) {
    return {
      matches: [],
      buckets: [],
      prebuiltContext: "",
      isComparison,
      maxContextChars: defaults.maxContextChars,
    };
  }

  if (typeof runEntityRetrieval !== "function") {
    throw new Error(
      "[multiEntityRetrieval] runEntityRetrieval callback is required",
    );
  }

  const isCompareMode =
    isComparison ||
    multiEntityMode === "compare" ||
    multiEntityMode === "choose_from_list";

  console.log(
    `[multiEntityRetrieval] Running per-entity retrieval for ${entityInputs.length} entities ` +
      `(topK=${perEntityK} each, maxTotal=${maxTotal}, mode=${multiEntityMode || (isComparison ? "compare" : "multi_ask")})`,
  );

  // Parallel full retrieval per entity plan (embed + hybrid + rerank inside callback).
  const rawBuckets = await Promise.all(
    entityInputs.map(async (input, index) => {
      const entity = input.name || input.entity || String(input);
      try {
        const matches = (await runEntityRetrieval(input, index)) || [];
        const sliced = matches.slice(0, perEntityK);
        console.log(
          `[multiEntityRetrieval] Entity "${entity}" → ${matches.length} hits, keeping top ${sliced.length}`,
        );
        return { entity, matches: sliced };
      } catch (err) {
        console.warn(
          `[multiEntityRetrieval] Entity "${entity}" retrieval failed: ${err.message}`,
        );
        return { entity, matches: [] };
      }
    }),
  );

  const buckets = rawBuckets.filter((b) => (b.matches || []).length > 0);
  const interleaved = interleaveEntityMatches(rawBuckets, maxTotal);

  const prebuiltContext = buildMultiEntityContext(rawBuckets, {
    isComparison: isCompareMode,
    maxTotalChars: defaults.maxContextChars,
    multiEntityMode,
  });

  console.log(
    `[multiEntityRetrieval] Interleaved ${interleaved.length} balanced matches ` +
      `across ${buckets.length}/${entityInputs.length} entities | context=${prebuiltContext.length} chars`,
  );

  return {
    matches: interleaved,
    buckets: rawBuckets,
    prebuiltContext,
    isComparison,
    maxContextChars: defaults.maxContextChars,
  };
}

module.exports = {
  runMultiEntityRetrieval,
  interleaveEntityMatches,
  buildMultiEntityContext,
  getMultiEntityRetrievalDefaults,
};
