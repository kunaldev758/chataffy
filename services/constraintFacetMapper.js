/**
 * Constraint → Facet Mapper.
 *
 * Pure data transformation layer: reshapes intent-router constraints into
 * facets for the retrieval policy engine. This module intentionally knows
 * NOTHING about retrieval strategy — it never decides hard filter vs. soft
 * boost vs. lexical hint, never references Qdrant, and never hardcodes a
 * field vocabulary. That keeps tenant-specific retrieval policy fully out
 * of the mapper (see retrievalPolicy.js) and lets new constraint fields
 * flow through without code changes here.
 */

const VALID_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
]);
const VALID_SOURCES = new Set(["user", "inferred", "rewrite", "history"]);

/**
 * @typedef {Object} Constraint
 * @property {string} field
 * @property {string} value
 * @property {string} [operator]
 * @property {number} [confidence]
 * @property {string} [source]
 */

/**
 * @typedef {Object} Facet
 * @property {string} key
 * @property {string} value
 * @property {string} operator
 * @property {number} confidence
 * @property {string} source
 */

function normalizeFieldKey(field) {
  return String(field || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeFacetValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOperator(operator) {
  const op = String(operator || "").trim().toLowerCase();
  return VALID_OPERATORS.has(op) ? op : "eq";
}

function normalizeSource(source) {
  const s = String(source || "").trim().toLowerCase();
  return VALID_SOURCES.has(s) ? s : "user";
}

function clampConfidence(confidence) {
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}

/**
 * Transform constraints[] into facets[]. Every constraint with a usable
 * field+value produces exactly one facet — no field is dropped for being
 * "unknown"; that decision belongs to the retrieval policy engine, which
 * falls back to soft/lexical treatment for anything it doesn't recognize.
 *
 * @param {Constraint[]} constraints
 * @returns {Facet[]}
 */
function mapConstraintsToFacets(constraints = []) {
  if (!Array.isArray(constraints)) return [];

  const facets = [];
  for (const constraint of constraints) {
    if (!constraint) continue;

    const key = normalizeFieldKey(constraint.field);
    const value = normalizeFacetValue(constraint.value);
    if (!key || !value) continue;

    facets.push({
      key,
      value,
      operator: normalizeOperator(constraint.operator),
      confidence: clampConfidence(constraint.confidence),
      source: normalizeSource(constraint.source),
    });
  }

  return facets;
}

module.exports = {
  mapConstraintsToFacets,
  normalizeFieldKey,
  normalizeFacetValue,
  normalizeOperator,
  normalizeSource,
  clampConfidence,
  VALID_OPERATORS,
  VALID_SOURCES,
};
