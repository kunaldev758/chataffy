/**
 * Retrieval Policy Engine.
 *
 * Decides HOW each facet is used during retrieval — hard Qdrant filter,
 * soft rerank boost, lexical hint, or ignored. This is the only layer that
 * encodes retrieval strategy. The constraint→facet mapper stays a pure
 * data transform (see constraintFacetMapper.js); tenants can override
 * policy here (which keys are safe to hard-filter, confidence thresholds,
 * etc.) without ever touching the mapper.
 */

const DEFAULT_HARD_FILTER_KEYS = new Set(["product_id", "sku"]);
const DEFAULT_HARD_FILTER_OPERATORS = new Set(["eq", "in"]);
const DEFAULT_HARD_FILTER_MIN_CONFIDENCE = 0.9;
const DEFAULT_MIN_USABLE_CONFIDENCE = 0.3;
const DEFAULT_PAGE_TYPE_IGNORE_BELOW = 0.5;
const DEFAULT_PAGE_TYPE_NORMAL_FROM = 0.6;
const DEFAULT_PAGE_TYPE_STRONG_ABOVE = 0.9;

/**
 * @typedef {import("./constraintFacetMapper").Facet} Facet
 */

/**
 * @typedef {Object} TenantRetrievalPolicy
 * @property {string[]} [hardFilterKeys] - facet keys allowed to become hard Qdrant filters
 * @property {number} [hardFilterMinConfidence]
 * @property {number} [minUsableConfidence] - below this, a facet is ignored entirely
 * @property {number} [pageTypeIgnoreBelow]
 * @property {number} [pageTypeNormalFrom]
 * @property {number} [pageTypeStrongAbove]
 */

function resolvePolicyConfig(tenantPolicy = {}) {
  return {
    hardFilterKeys: new Set(
      Array.isArray(tenantPolicy.hardFilterKeys)
        ? tenantPolicy.hardFilterKeys
        : DEFAULT_HARD_FILTER_KEYS,
    ),
    hardFilterOperators: new Set(
      Array.isArray(tenantPolicy.hardFilterOperators)
        ? tenantPolicy.hardFilterOperators
        : DEFAULT_HARD_FILTER_OPERATORS,
    ),
    hardFilterMinConfidence:
      typeof tenantPolicy.hardFilterMinConfidence === "number"
        ? tenantPolicy.hardFilterMinConfidence
        : DEFAULT_HARD_FILTER_MIN_CONFIDENCE,
    minUsableConfidence:
      typeof tenantPolicy.minUsableConfidence === "number"
        ? tenantPolicy.minUsableConfidence
        : DEFAULT_MIN_USABLE_CONFIDENCE,
    pageTypeIgnoreBelow:
      typeof tenantPolicy.pageTypeIgnoreBelow === "number"
        ? tenantPolicy.pageTypeIgnoreBelow
        : DEFAULT_PAGE_TYPE_IGNORE_BELOW,
    pageTypeNormalFrom:
      typeof tenantPolicy.pageTypeNormalFrom === "number"
        ? tenantPolicy.pageTypeNormalFrom
        : DEFAULT_PAGE_TYPE_NORMAL_FROM,
    pageTypeStrongAbove:
      typeof tenantPolicy.pageTypeStrongAbove === "number"
        ? tenantPolicy.pageTypeStrongAbove
        : DEFAULT_PAGE_TYPE_STRONG_ABOVE,
  };
}

function isEligibleForHardFilter(facet, policyConfig) {
  return (
    policyConfig.hardFilterKeys.has(facet.key) &&
    policyConfig.hardFilterOperators.has(facet.operator) &&
    facet.confidence >= policyConfig.hardFilterMinConfidence
  );
}

/**
 * Classify facets into hardFilters / softBoosts / lexicalHints / ignored.
 * A facet can land in hardFilters (exclusive) OR softBoosts+lexicalHints
 * (soft facets always also contribute a lexical hint, since unindexed or
 * unrecognized fields still need to be searchable).
 *
 * @param {Facet[]} facets
 * @param {object} policyConfig
 */
function classifyFacets(facets = [], policyConfig) {
  const hardFilters = [];
  const softBoosts = [];
  const lexicalHints = [];
  const ignored = [];

  for (const facet of facets) {
    if (facet?.key === "pageType") {
      if (facet.confidence < policyConfig.pageTypeIgnoreBelow) {
        ignored.push(facet);
        continue;
      }

      const boostStrength =
        facet.confidence > policyConfig.pageTypeStrongAbove
          ? "strong"
          : facet.confidence >= policyConfig.pageTypeNormalFrom
            ? "normal"
            : "weak";
      softBoosts.push({ ...facet, boostStrength });
      // pageType is structured metadata, not useful sparse-query text.
      continue;
    }

    if (!facet || facet.confidence < policyConfig.minUsableConfidence) {
      if (facet) ignored.push(facet);
      continue;
    }

    if (isEligibleForHardFilter(facet, policyConfig)) {
      hardFilters.push(facet);
      continue;
    }

    // Generic soft path: any field, known or unknown, becomes a soft boost
    // (matched against payload when the key is indexed) AND a lexical hint
    // (matched against text when it isn't). Nothing is discarded.
    softBoosts.push(facet);
    lexicalHints.push(facet.value);
  }

  return { hardFilters, softBoosts, lexicalHints, ignored };
}

/**
 * @param {object} params
 * @param {string} [params.intent]
 * @param {string|null} [params.subIntent]
 * @param {Facet[]} [params.facets]
 * @param {string[]} [params.lexicalTerms] - base lexical terms to merge with lexical hints
 * @param {TenantRetrievalPolicy} [params.tenantPolicy] - per-tenant overrides
 */
function applyRetrievalPolicy({
  intent = null,
  subIntent = null,
  facets = [],
  lexicalTerms = [],
  tenantPolicy = {},
} = {}) {
  const policyConfig = resolvePolicyConfig(tenantPolicy);
  const { hardFilters, softBoosts, lexicalHints, ignored } = classifyFacets(
    facets,
    policyConfig,
  );

  const mergedLexicalTerms = [
    ...new Set([...(lexicalTerms || []), ...lexicalHints]),
  ].slice(0, 40);

  return {
    hardFilters,
    softBoosts,
    ignored,
    softBoostKeys: [...new Set(softBoosts.map((f) => f.key))],
    lexicalTerms: mergedLexicalTerms,
  };
}

module.exports = {
  applyRetrievalPolicy,
  classifyFacets,
  resolvePolicyConfig,
  DEFAULT_HARD_FILTER_KEYS,
  DEFAULT_HARD_FILTER_OPERATORS,
  DEFAULT_HARD_FILTER_MIN_CONFIDENCE,
  DEFAULT_MIN_USABLE_CONFIDENCE,
  DEFAULT_PAGE_TYPE_IGNORE_BELOW,
  DEFAULT_PAGE_TYPE_NORMAL_FROM,
  DEFAULT_PAGE_TYPE_STRONG_ABOVE,
};
