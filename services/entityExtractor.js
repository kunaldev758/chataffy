/**
 * Extract structured entities from page content for entity-level indexing.
 */

const { ENTITY_TYPE } = require("../constants/contentTypes");
const {
  parseSizesFromText,
  sizeBoundsFromList,
  extractPriceFromText,
  extractCurrencyFromText,
} = require("../utils/entitySizeMatch");

const PRICE_PATTERN = /(?:\$|€|£)\s*[\d,.]+|[\d,.]+\s*(?:USD|EUR|GBP)/i;

function cleanEntityName(name) {
  return (name || "")
    .replace(/^#+\s*/, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchText(entity) {
  const parts = [
    entity.name,
    entity.entity_type,
    ...(entity.attributes?.sizes || []),
    entity.attributes?.collection,
    entity.attributes?.price != null ? String(entity.attributes.price) : "",
    entity.attributes?.brand,
    entity.url,
  ].filter(Boolean);
  return parts.join(" ");
}

function stripPriceFromLine(line) {
  return (line || "")
    .replace(/(?:\$|€|£)\s*[\d,.]+/g, "")
    .replace(/[\d,.]+\s*(?:USD|EUR|GBP)/gi, "")
    .trim();
}

function entityFromLine({ line, url, title, entityType, index = 0 }) {
  const sizes = parseSizesFromText(line);
  const price = extractPriceFromText(line);
  const bounds = sizeBoundsFromList(sizes);

  let name = cleanEntityName(stripPriceFromLine(line));
  if (name.length > 120) name = name.slice(0, 120).trim();

  if (!name || name.length < 2) {
    name = cleanEntityName(title) || `Item ${index + 1}`;
  }

  const attributes = {
    sizes,
    size_min: bounds.size_min,
    size_max: bounds.size_max,
    price,
    currency: extractCurrencyFromText(line),
    collection: /\bsuper\s*natural\b/i.test(line) ? "Super Natural" : undefined,
  };

  if (attributes.collection === undefined) delete attributes.collection;

  const entity = {
    name,
    entity_type: entityType || ENTITY_TYPE.PRODUCT,
    url,
    attributes,
  };

  entity.search_text = buildSearchText(entity);
  return entity;
}

function parseEntityLines(content, { url, title, entityType }) {
  const lines = (content || "").split(/\n+/);
  const entities = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 6) continue;

    const hasSize = /\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(line);
    const hasPrice = PRICE_PATTERN.test(line);

    if (!hasSize && !hasPrice) continue;

    const entity = entityFromLine({ line, url, title, entityType, index: i });
    const key = `${entity.name}::${(entity.attributes.sizes || []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (entity.attributes.sizes.length > 0 || entity.attributes.price != null) {
      entities.push(entity);
    }
  }

  return entities;
}

/**
 * @param {{ content: string, title?: string, url?: string, entity_type?: string }} fields
 * @returns {object[]}
 */
function extractEntities({ content, title = "", url = "", entity_type } = {}) {
  const entityType = entity_type || ENTITY_TYPE.PRODUCT;
  const fromLines = parseEntityLines(content, { url, title, entityType });

  if (fromLines.length > 0) return fromLines;

  const pageSizes = parseSizesFromText(`${title} ${content}`);
  const pagePrice = extractPriceFromText(content);
  const bounds = sizeBoundsFromList(pageSizes);

  if (pageSizes.length === 0 && pagePrice == null) return [];

  const name = cleanEntityName(title) || cleanEntityName(url.split("/").pop() || "Item");
  const entity = {
    name,
    entity_type: entityType,
    url,
    attributes: {
      sizes: pageSizes,
      size_min: bounds.size_min,
      size_max: bounds.size_max,
      price: pagePrice,
      currency: extractCurrencyFromText(content),
    },
  };
  entity.search_text = buildSearchText(entity);
  return [entity];
}

function formatEntityPageContent(entity) {
  const { name, url, attributes = {} } = entity;
  const lines = [`Name: ${name}`];

  if (attributes.sizes?.length) {
    lines.push(`Sizes: ${attributes.sizes.join(", ")}`);
  }
  if (attributes.price != null) {
    const cur = attributes.currency ? ` ${attributes.currency}` : "";
    lines.push(`Price: ${attributes.price}${cur}`);
  }
  if (attributes.collection) lines.push(`Collection: ${attributes.collection}`);
  if (attributes.brand) lines.push(`Brand: ${attributes.brand}`);
  if (url) lines.push(`URL: ${url}`);

  return lines.join("\n");
}

module.exports = {
  extractEntities,
  formatEntityPageContent,
  entityFromLine,
  buildSearchText,
};
