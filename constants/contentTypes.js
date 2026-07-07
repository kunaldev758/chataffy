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
  COURSE: "course",
  PERSON: "person",
  PROPERTY: "property",
  GENERIC: "generic",
};

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
  SEARCH_INTENT,
  INDEXED_PAYLOAD_FIELDS,
};
