/**
 * Progressive Qdrant filters for product-related SEMANTIC_RAG / catalog queries.
 * Tier order: strict → soft → base (never fail closed).
 */

const PRODUCT_ENTITY_TYPES = ["product", "listing"];

function normalizeSizeToken(s) {
  return String(s || "")
    .replace(/\s/g, "")
    .toLowerCase()
    .trim();
}

function normalizeStringList(values, { max = 12 } = {}) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const s = String(v || "")
      .trim()
      .toLowerCase();
    if (s.length > 1) out.push(s);
  }
  return [...new Set(out)].slice(0, max);
}

/**
 * Normalize product attributes from the intent router (or heuristics).
 */
function normalizeProductAttributes(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return {
      entity_name: null,
      sizes: [],
      collections: [],
      color: null,
      price_min: null,
      price_max: null,
      keywords: [],
    };
  }

  const sizes = normalizeStringList(
    [
      ...(Array.isArray(raw.sizes) ? raw.sizes : []),
      ...(raw.size ? [raw.size] : []),
    ].map(normalizeSizeToken),
  );

  const priceMin =
    typeof raw.price_min === "number"
      ? raw.price_min
      : typeof raw.priceMin === "number"
        ? raw.priceMin
        : null;
  const priceMax =
    typeof raw.price_max === "number"
      ? raw.price_max
      : typeof raw.priceMax === "number"
        ? raw.priceMax
        : null;

  const entityName =
    typeof raw.entity_name === "string" && raw.entity_name.trim()
      ? raw.entity_name.trim()
      : typeof raw.entityName === "string" && raw.entityName.trim()
        ? raw.entityName.trim()
        : null;

  return {
    entity_name: entityName,
    sizes,
    collections: normalizeStringList(raw.collections || raw.collection || []),
    color:
      typeof raw.color === "string" && raw.color.trim()
        ? raw.color.trim().toLowerCase()
        : null,
    price_min: priceMin,
    price_max: priceMax,
    keywords: normalizeStringList(raw.keywords || [], { max: 20 }),
  };
}

/**
 * Whether this query should use product-oriented retrieval filters.
 */
function isProductRelatedQuery(queryAttributes = {}, routing = {}) {
  if (queryAttributes?.flags?.isProductQuery) return true;
  if (routing?.isProductQuery) return true;

  const sub = queryAttributes?.subIntent || routing?.subIntent;
  if (sub === "IN_PAGE_LIST") return true;

  if (
    queryAttributes?.flags?.isCatalogQuery ||
    queryAttributes?.flags?.wantsProductLinks ||
    queryAttributes?.flags?.wantsPrices
  ) {
    return true;
  }

  if (queryAttributes?.sizes?.length > 0) return true;
  if (queryAttributes?.entity_name) return true;
  if (queryAttributes?.collections?.length > 0) return true;

  return false;
}

function baseTenantClauses(userId) {
  const must = [];
  const must_not = [
    {
      key: "is_active",
      match: { value: false },
    },
  ];
  if (userId) {
    must.push({
      key: "user_id",
      match: { value: userId.toString() },
    });
  }
  return { must, must_not };
}

function wrapFilter(must, must_not, should = null) {
  const filter = {};
  if (must?.length) filter.must = must;
  if (must_not?.length) filter.must_not = must_not;
  if (should?.length) {
    filter.should = should;
    filter.min_should = 1;
  }
  return Object.keys(filter).length ? filter : undefined;
}

/**
 * Build ordered filter tiers for progressive semantic search.
 * @returns {{ name: string, filter: object }[]}
 */
function buildProductFilterTiers({
  userId,
  sizes = [],
  collections = [],
  entityName = null,
  isProductQuery = false,
} = {}) {
  const { must: baseMust, must_not } = baseTenantClauses(userId);
  const sizeTokens = (sizes || []).map(normalizeSizeToken).filter(Boolean);
  const collectionTokens = normalizeStringList(collections);
  const tiers = [];

  const pushUnique = (name, filter) => {
    if (!filter) return;
    if (tiers.some((t) => t.name === name)) return;
    tiers.push({ name, filter });
  };

  // Tier 1: named entity + sizes (highest precision)
  if (isProductQuery && entityName && sizeTokens.length) {
    pushUnique(
      "entity_name_sizes",
      wrapFilter(
        [
          ...baseMust,
          { key: "entity_name", match: { value: entityName } },
          { key: "sizes", match: { any: sizeTokens } },
        ],
        must_not,
      ),
    );
  }

  // Tier 2: entity_name only
  if (isProductQuery && entityName) {
    pushUnique(
      "entity_name",
      wrapFilter(
        [...baseMust, { key: "entity_name", match: { value: entityName } }],
        must_not,
      ),
    );
  }

  // Tier 3: sizes + entity_type product|listing
  if (isProductQuery && sizeTokens.length) {
    pushUnique(
      "product_type_sizes",
      wrapFilter(
        [
          ...baseMust,
          { key: "sizes", match: { any: sizeTokens } },
          { key: "entity_type", match: { any: PRODUCT_ENTITY_TYPES } },
        ],
        must_not,
      ),
    );
  }

  // Tier 4: sizes only (legacy-compatible)
  if (sizeTokens.length) {
    pushUnique(
      "sizes_only",
      wrapFilter(
        [...baseMust, { key: "sizes", match: { any: sizeTokens } }],
        must_not,
      ),
    );
  }

  // Tier 5: collections + product type
  if (isProductQuery && collectionTokens.length) {
    pushUnique(
      "collections_product",
      wrapFilter(
        [
          ...baseMust,
          { key: "collections", match: { any: collectionTokens } },
          { key: "entity_type", match: { any: PRODUCT_ENTITY_TYPES } },
        ],
        must_not,
      ),
    );
    pushUnique(
      "collections_only",
      wrapFilter(
        [
          ...baseMust,
          { key: "collections", match: { any: collectionTokens } },
        ],
        must_not,
      ),
    );
  }

  // Tier 6: product entity_type only (named/product Q without size)
  if (isProductQuery) {
    pushUnique(
      "entity_type_product",
      wrapFilter(
        [
          ...baseMust,
          { key: "entity_type", match: { any: PRODUCT_ENTITY_TYPES } },
        ],
        must_not,
      ),
    );
  }

  // Tier 7: tenant only
  pushUnique("base", wrapFilter(baseMust, must_not));

  return tiers;
}

/**
 * Indexes needed for product filter tiers (create lazily; ignore "already exists").
 */
function productFilterIndexFields(tiers = []) {
  const fields = new Set(["user_id", "sizes"]);
  for (const tier of tiers) {
    const clauses = [
      ...(tier.filter?.must || []),
      ...(tier.filter?.should || []),
    ];
    for (const c of clauses) {
      if (c?.key) fields.add(c.key);
    }
  }
  return [...fields];
}

module.exports = {
  PRODUCT_ENTITY_TYPES,
  normalizeProductAttributes,
  isProductRelatedQuery,
  buildProductFilterTiers,
  productFilterIndexFields,
  normalizeSizeToken,
};
