/**
 * Retrieval Plan Builder — Multi-Entity
 * -----------------------------------
 * Transforms resolved entity names into retrieval-ready plans.
 * Does NOT call Qdrant or embed — only shapes query strings + policy hints.
 *
 * @typedef {Object} EntityPlan
 * @property {string} name
 * @property {string} denseQuery
 * @property {string} sparseQuery
 * @property {string[]} lexicalKeywords
 * @property {string} [source]
 */

const { MULTI_ENTITY_MODES } = require("./multiEntityModes");
const { getMultiEntityRetrievalDefaults } = require("./multiEntityRetrieval");

const RETRIEVAL_STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "about", "tell", "me",
]);

/**
 * Tokenize entity name into keyword hints for sparse / attribute rerank.
 * @param {string} name
 * @returns {string[]}
 */
function buildLexicalKeywords(name) {
  const tokens = String(name || "")
    .toLowerCase()
    .replace(/[^\w\s.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !RETRIEVAL_STOP.has(w));

  const keywords = new Set();
  const full = String(name || "").trim();
  if (full.length >= 2) keywords.add(full);
  for (const t of tokens) keywords.add(t);

  // Progressive prefixes for long product names (e.g. "Courtside Playmaker Board")
  if (tokens.length >= 2) {
    keywords.add(tokens.slice(0, 2).join(" "));
    if (tokens.length >= 3) {
      keywords.add(tokens.slice(0, 3).join(" "));
    }
  }

  return [...keywords].slice(0, 8);
}

/**
 * Build dense embedding text for one entity.
 * @param {string} name
 * @param {string|null} multiEntityMode
 * @returns {string}
 */
function buildDenseQuery(name, multiEntityMode = null) {
  const n = String(name || "").trim();
  const base = `${n} product description price specs features`;
  if (multiEntityMode === MULTI_ENTITY_MODES.COMPARE) {
    return `${base} comparison specifications`;
  }
  if (multiEntityMode === MULTI_ENTITY_MODES.CHOOSE_FROM_LIST) {
    return `${base} recommendation use case`;
  }
  return base;
}

/**
 * Build one entity retrieval plan.
 * @param {string} name
 * @param {object} [options]
 * @returns {EntityPlan}
 */
function buildEntityPlan(name, options = {}) {
  const entityName = String(name || "").trim();
  return {
    name: entityName,
    denseQuery: buildDenseQuery(entityName, options.multiEntityMode),
    sparseQuery: entityName,
    lexicalKeywords: buildLexicalKeywords(entityName),
    source: options.source || "resolved",
  };
}

/**
 * Build multi-entity retrieval plan + policy overrides.
 *
 * @param {object} params
 * @param {string|null} params.multiEntityMode
 * @param {string[]} params.entities - resolved names (length >= 2)
 * @param {object} [params.baseRetrievalPlan] - from buildRetrievalPlan()
 * @returns {null | {
 *   multiEntityMode: string,
 *   entities: EntityPlan[],
 *   policy: object,
 * }}
 */
function buildMultiEntityRetrievalPlan({
  multiEntityMode,
  entities = [],
  baseRetrievalPlan = null,
} = {}) {
  if (!multiEntityMode || !Array.isArray(entities) || entities.length < 2) {
    return null;
  }

  const defaults = getMultiEntityRetrievalDefaults();
  const entityPlans = entities.map((name) =>
    buildEntityPlan(name, { multiEntityMode }),
  );

  const basePolicy = baseRetrievalPlan?.retrievalPolicy || {};

  const policy = {
    ...basePolicy,
    contextMode: "compare",
    tokenBudget: defaults.maxContextChars,
    semanticTopK: Math.min(40, basePolicy.semanticTopK || 40),
    finalTopK: defaults.maxTotalMatches,
    topKPerEntity: defaults.topKPerEntity,
    maxTotalMatches: defaults.maxTotalMatches,
  };

  console.log(
    `[entityPlanBuilder] Built ${entityPlans.length} entity plans ` +
      `(mode=${multiEntityMode}, topKPerEntity=${policy.topKPerEntity})`,
  );

  return {
    multiEntityMode,
    entities: entityPlans,
    policy,
  };
}

module.exports = {
  buildLexicalKeywords,
  buildDenseQuery,
  buildEntityPlan,
  buildMultiEntityRetrievalPlan,
};
