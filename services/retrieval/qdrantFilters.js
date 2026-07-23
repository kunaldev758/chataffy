/**
 * Build Qdrant payload filters aligned with content-pipeline chunk schema.
 */

/**
 * @param {object} opts
 * @param {string} [opts.userId]
 * @param {string} [opts.agentId]
 * @param {object} [opts.strategy] - from buildRetrievalStrategy
 * @param {boolean} [opts.includeInactive=false]
 */
function buildQdrantHardFilter({
  userId = null,
  agentId = null,
  strategy = null,
  includeInactive = false,
} = {}) {
  const must = [];

  if (userId) {
    must.push({
      key: "user_id",
      match: { value: String(userId) },
    });
  }

  if (agentId) {
    must.push({
      key: "agent_id",
      match: { value: String(agentId) },
    });
  }

  if (!includeInactive) {
    // Prefer active chunks; tolerate missing is_active on legacy points via should
    must.push({
      key: "is_active",
      match: { value: true },
    });
  }

  if (
    strategy?.hardFilterEntity &&
    Array.isArray(strategy.preferredEntityTypes) &&
    strategy.preferredEntityTypes.length > 0
  ) {
    must.push({
      key: "entity_type",
      match: { any: strategy.preferredEntityTypes },
    });
  }

  // Nested attribute hard filters (only when strategy opts in)
  if (strategy?.hardFilterAttributes && strategy.attributeHardFilters) {
    const sizes = strategy.attributeHardFilters.sizes || [];
    if (sizes.length > 0) {
      const normalized = sizes.map((s) =>
        String(s).replace(/\s/g, "").toLowerCase(),
      );
      // Try both legacy top-level sizes and nested attributes.sizes
      must.push({
        should: [
          { key: "sizes", match: { any: normalized } },
          { key: "attributes.sizes", match: { any: normalized } },
        ],
      });
    }
  }

  return must.length > 0 ? { must } : undefined;
}

/**
 * Softer filter without is_active (legacy points may omit the field).
 */
function buildQdrantHardFilterLegacyCompatible(opts = {}) {
  const filter = buildQdrantHardFilter({ ...opts, includeInactive: true });
  if (!filter) return undefined;

  const must = [];
  if (opts.userId) {
    must.push({ key: "user_id", match: { value: String(opts.userId) } });
  }
  if (opts.agentId) {
    must.push({ key: "agent_id", match: { value: String(opts.agentId) } });
  }
  if (
    opts.strategy?.hardFilterEntity &&
    opts.strategy.preferredEntityTypes?.length
  ) {
    must.push({
      key: "entity_type",
      match: { any: opts.strategy.preferredEntityTypes },
    });
  }
  return must.length ? { must } : undefined;
}

module.exports = {
  buildQdrantHardFilter,
  buildQdrantHardFilterLegacyCompatible,
};
