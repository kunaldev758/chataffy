/**
 * Canonical content / entity types for indexing and retrieval.
 * Extend ENTITY_TYPES and ATTRIBUTE_KEYS per vertical without changing core pipeline.
 */

const DOC_TYPE = {
  ENTITY: "entity",
  CATEGORY: "category",
  KNOWLEDGE: "knowledge",
};

const ENTITY_TYPE = {
  PRODUCT: "product",
  SERVICE: "service",
  FAQ: "faq",
  CONTACT: "contact",
  CATEGORY: "category",
  ABOUT: "about",
  BLOG: "blog",
  COURSE: "course",
  PERSON: "person",
  PROPERTY: "property",
  GENERIC: "generic",
};

/** Entity types detected at the page level by the Entity Extraction Engine.
 *  A single page URL can match multiple of these. */
const PAGE_ENTITY_TYPES = [
  ENTITY_TYPE.PRODUCT,
  ENTITY_TYPE.FAQ,
  ENTITY_TYPE.CONTACT,
  ENTITY_TYPE.SERVICE,
  ENTITY_TYPE.CATEGORY,
  ENTITY_TYPE.ABOUT,
  ENTITY_TYPE.BLOG,
];

const SEARCH_INTENT = {
  ENTITY: "entity_search",
  CATEGORY: "category_search",
  KNOWLEDGE: "knowledge_search",
  MIXED: "mixed_search",
};

/** Payload fields indexed in Qdrant for filtering */
const INDEXED_PAYLOAD_FIELDS = {
  doc_type: "keyword",
  entity_type: "keyword",
  entity_name: "keyword",
};

module.exports = {
  DOC_TYPE,
  ENTITY_TYPE,
  PAGE_ENTITY_TYPES,
  SEARCH_INTENT,
  INDEXED_PAYLOAD_FIELDS,
};
