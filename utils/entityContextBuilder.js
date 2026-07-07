/**
 * Build LLM context blocks by doc_type (entity table, category summary, knowledge prose).
 */

const { DOC_TYPE } = require("../constants/contentTypes");
const { querySizesMatchAttributes } = require("./entitySizeMatch");

function matchPayload(match) {
  return match.payload || match.metadata || match;
}

function normalizeName(name) {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable key for deduplicating product rows (one row per SKU/page).
 */
function entityDedupeKey(match) {
  const p = matchPayload(match);
  const url = (p.url || "").toLowerCase().split("?")[0].replace(/\/$/, "");
  const name = normalizeName(p.entity_name || p.title || "");

  if ((p.doc_type || "") === DOC_TYPE.ENTITY) {
    if (url) return `entity::${url}::${name}`;
    if (name) return `entity::${name}`;
  }

  if (url && /\/products?\//i.test(url)) {
    return `product-url::${url}`;
  }

  if (name && /\d{1,2}(?:-\d{1,2})?mm/i.test(name)) {
    return `sized-name::${name}`;
  }

  if (url) return `url::${url}`;
  if (name) return `name::${name}`;

  return `chunk::${url}::${(p.text || "").slice(0, 100)}`;
}

/**
 * Keep highest-scoring match per product key.
 */
function deduplicateEntityMatches(matches) {
  const byKey = new Map();

  for (const match of matches || []) {
    const key = entityDedupeKey(match);
    const existing = byKey.get(key);
    if (!existing || (match.score ?? 0) > (existing.score ?? 0)) {
      byKey.set(key, match);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
}

function formatEntityRow(payload) {
  const attrs = payload.attributes || {};
  const name = payload.entity_name || payload.title || "Item";
  const sizes = attrs.sizes?.length
    ? attrs.sizes.join(", ")
    : payload.sizes?.join(", ") || "";
  const price =
    attrs.price != null ? `${attrs.currency || "$"}${attrs.price}` : "";
  const url = payload.url || "";

  const parts = [name];
  if (sizes) parts.push(`(${sizes})`);
  if (price) parts.push(`— ${price}`);
  if (url) parts.push(`| ${url}`);

  return parts.join(" ");
}

/**
 * @param {object[]} matches
 * @param {string[]} querySizes
 * @param {{ entityOnlyStrict?: boolean }} [options]
 */
function filterEntityMatches(matches, querySizes = [], options = {}) {
  const { entityOnlyStrict = false } = options;
  const pool = matches || [];

  if (!querySizes?.length) {
    return deduplicateEntityMatches(pool);
  }

  const entityMatches = pool.filter(
    (m) => (matchPayload(m).doc_type || "") === DOC_TYPE.ENTITY,
  );

  if (entityMatches.length > 0 || entityOnlyStrict) {
    const filtered = entityMatches.filter((m) => {
      const p = matchPayload(m);
      return querySizesMatchAttributes(querySizes, {
        sizes: p.sizes || p.attributes?.sizes,
        size_min: p.attributes?.size_min ?? p.size_min,
        size_max: p.attributes?.size_max ?? p.size_max,
      });
    });
    return deduplicateEntityMatches(filtered);
  }

  const legacy = pool.filter((m) => {
    const p = matchPayload(m);
    return querySizesMatchAttributes(querySizes, {
      sizes: p.sizes || p.attributes?.sizes,
      size_min: p.attributes?.size_min ?? p.size_min,
      size_max: p.attributes?.size_max ?? p.size_max,
    });
  });

  return deduplicateEntityMatches(legacy);
}

function buildEntityTableContext(matches, options = {}) {
  const {
    querySizes = [],
    maxItems = 20,
    companyName = "the store",
    entityOnlyStrict = false,
  } = options;

  const filtered = filterEntityMatches(matches, querySizes, {
    entityOnlyStrict,
  });
  const rows = filtered
    .slice(0, maxItems)
    .map((m) => formatEntityRow(matchPayload(m)));

  if (rows.length === 0) {
    return `No matching products found in ${companyName}'s catalog for the requested filters.`;
  }

  return [
    `Matching products (${rows.length}):`,
    ...rows.map((r, i) => `${i + 1}. ${r}`),
  ].join("\n");
}

function buildEmptyCatalogContext(question, queryAttributes, companyName) {
  const sizes = (queryAttributes?.sizes || []).join(", ") || "the requested size";
  return (
    `The user asked: "${question}". ` +
    `No products matching size(s) ${sizes} were found in ${companyName}'s indexed catalog. ` +
    `Tell the user politely that there are no exact matches for that size. ` +
    `Do not invent product names, prices, or URLs. ` +
    `If helpful, suggest they try a nearby size range or browse the full collection on the website.`
  );
}

function buildEmptyContactContext(question, companyName) {
  return (
    `The user asked: "${question}". ` +
    `No contact details or social media URLs were found in ${companyName}'s indexed website content. ` +
    `Tell the user politely that you could not find social media links or contact information in the available data. ` +
    `Do not invent URLs, phone numbers, or email addresses. ` +
    `Suggest they check the website footer or contact page directly.`
  );
}

function buildCategorySummaryContext(matches, options = {}) {
  const maxItems = options.maxItems ?? 8;
  const blocks = [];

  for (const match of (matches || []).slice(0, maxItems)) {
    const p = matchPayload(match);
    if (
      (p.doc_type || "") !== DOC_TYPE.CATEGORY &&
      !/\/collections?\//i.test(p.url || "")
    ) {
      continue;
    }
    const title = p.title || p.url || "Category";
    const text = (p.text || "").slice(0, 800);
    blocks.push(`Category: ${title}\n${p.url ? `URL: ${p.url}\n` : ""}${text}`);
  }

  return blocks.join("\n\n");
}

function buildKnowledgeProseContext(matches, options = {}) {
  const maxChars = options.maxTotalChars ?? 6000;
  const blocks = [];
  let total = 0;

  for (const match of matches || []) {
    const p = matchPayload(match);
    const text = p.text || "";
    if (!text) continue;
    const block = p.title ? `${p.title}\n${text}` : text;
    if (total + block.length > maxChars) break;
    blocks.push(block);
    total += block.length;
  }

  return blocks.join("\n\n");
}

/**
 * @param {object[]} matches
 * @param {{ intent?: string, querySizes?: string[], companyName?: string, maxItems?: number, entityOnlyStrict?: boolean }} options
 */
function buildTypedContext(matches, options = {}) {
  const {
    intent,
    querySizes = [],
    companyName,
    maxItems = 20,
    entityOnlyStrict = false,
  } = options;

  if (intent === "entity_search" || querySizes.length > 0) {
    return buildEntityTableContext(matches, {
      querySizes,
      maxItems,
      companyName,
      entityOnlyStrict,
    });
  }

  if (intent === "category_search") {
    const category = buildCategorySummaryContext(matches, { maxItems });
    if (category.trim()) return category;
  }

  if (intent === "knowledge_search") {
    return buildKnowledgeProseContext(matches, options);
  }

  const entityBlock = buildEntityTableContext(matches, {
    querySizes,
    maxItems: Math.min(maxItems, 10),
    companyName,
    entityOnlyStrict,
  });
  const knowledgeBlock = buildKnowledgeProseContext(matches, {
    maxTotalChars: 3000,
  });

  if (entityBlock && !entityBlock.startsWith("No matching")) {
    return knowledgeBlock
      ? `${entityBlock}\n\n---\nAdditional info:\n${knowledgeBlock}`
      : entityBlock;
  }

  return knowledgeBlock || entityBlock;
}

module.exports = {
  buildTypedContext,
  buildEntityTableContext,
  buildCategorySummaryContext,
  buildKnowledgeProseContext,
  buildEmptyCatalogContext,
  buildEmptyContactContext,
  filterEntityMatches,
  deduplicateEntityMatches,
  formatEntityRow,
  entityDedupeKey,
};
