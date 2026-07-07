/**
 * Classify crawled / uploaded content into doc_type for indexing.
 * Rule-based and URL-heuristic first — extend with CMS hooks or LLM later.
 */

const { DOC_TYPE, ENTITY_TYPE } = require("../constants/contentTypes");
const { extractSizeTokens } = require("../utils/queryNormalization");

const PRODUCT_URL = /\/products?\//i;
const COLLECTION_URL = /\/collections?\//i;
const CATEGORY_URL = /\/(category|categories|shop|catalog)\b/i;
const FAQ_URL = /\/(faq|faqs|help|support)\b/i;
const BLOG_URL = /\/(blog|news|articles?)\b/i;
const POLICY_URL = /\/(policy|policies|terms|privacy|shipping|returns?)\b/i;
const CONTACT_URL = /\/(contact|about-us|about)\b/i;

const PRICE_PATTERN = /(?:\$|€|£|USD|EUR)\s*[\d,.]+|[\d,.]+\s*(?:USD|EUR|GBP)/i;

function inferEntityType({ url = "", title = "", content = "", metadata = {} } = {}) {
  const combined = `${title} ${url} ${content}`.toLowerCase();

  if (metadata.entity_type) return metadata.entity_type;
  if (PRODUCT_URL.test(url) || /\b(add to cart|sku|variant)\b/i.test(combined)) {
    return ENTITY_TYPE.PRODUCT;
  }
  if (/\b(course|curriculum|lesson|enroll)\b/i.test(combined)) {
    return ENTITY_TYPE.COURSE;
  }
  if (/\b(dr\.|doctor|physician|dentist|clinic)\b/i.test(combined)) {
    return ENTITY_TYPE.PERSON;
  }
  if (/\b(bedroom|sq\.?\s*ft|property listing|for sale|for rent)\b/i.test(combined)) {
    return ENTITY_TYPE.PROPERTY;
  }
  if (/\b(service|consulting|appointment)\b/i.test(combined)) {
    return ENTITY_TYPE.SERVICE;
  }
  return ENTITY_TYPE.GENERIC;
}

/**
 * @param {{ content?: string, title?: string, url?: string, metadata?: object }} doc
 * @returns {{ doc_type: string, entity_type: string|null, confidence: string, reason: string }}
 */
function classifyDocument(doc) {
  const content = doc.content || "";
  const title = doc.metadata?.title || doc.title || "";
  const url = doc.metadata?.url || doc.originalUrl || "";
  const metaType = (doc.metadata?.type || "").toLowerCase();
  const trainingType = doc.type;

  if (metaType === "faq" || trainingType === 3) {
    return {
      doc_type: DOC_TYPE.KNOWLEDGE,
      entity_type: null,
      confidence: "high",
      reason: "faq_type",
    };
  }

  if (metaType === "snippet" || metaType === "file" || trainingType === 1 || trainingType === 2) {
    return {
      doc_type: DOC_TYPE.KNOWLEDGE,
      entity_type: null,
      confidence: "high",
      reason: "uploaded_knowledge",
    };
  }

  if (CONTACT_URL.test(url) && !PRICE_PATTERN.test(content)) {
    return {
      doc_type: DOC_TYPE.KNOWLEDGE,
      entity_type: null,
      confidence: "medium",
      reason: "contact_page",
    };
  }

  if (FAQ_URL.test(url) || BLOG_URL.test(url) || POLICY_URL.test(url)) {
    return {
      doc_type: DOC_TYPE.KNOWLEDGE,
      entity_type: null,
      confidence: "high",
      reason: "knowledge_url",
    };
  }

  const sizes = extractSizeTokens(`${title} ${content}`);
  const hasPrice = PRICE_PATTERN.test(content);
  const entityCandidates = extractEntityCandidates(content, title);
  const hasCatalogSignals =
    sizes.length > 0 && (hasPrice || /\b(lash|lashes|product|item|style)\b/i.test(content));

  if (
    hasCatalogSignals &&
    (entityCandidates.length > 1 || PRODUCT_URL.test(url))
  ) {
    return {
      doc_type: DOC_TYPE.ENTITY,
      entity_type: inferEntityType({ url, title, content, metadata: doc.metadata }),
      confidence: entityCandidates.length > 1 ? "high" : "medium",
      reason:
        entityCandidates.length > 1
          ? "multi_entity_catalog_page"
          : "product_url",
    };
  }

  if (COLLECTION_URL.test(url) || CATEGORY_URL.test(url)) {
    return {
      doc_type: DOC_TYPE.CATEGORY,
      entity_type: null,
      confidence: "high",
      reason: "collection_url",
    };
  }

  if (PRODUCT_URL.test(url)) {
    return {
      doc_type: DOC_TYPE.ENTITY,
      entity_type: inferEntityType({ url, title, content, metadata: doc.metadata }),
      confidence: "high",
      reason: "product_url",
    };
  }

  if (hasCatalogSignals) {
    return {
      doc_type: DOC_TYPE.ENTITY,
      entity_type: inferEntityType({ url, title, content, metadata: doc.metadata }),
      confidence: "medium",
      reason: "catalog_signals",
    };
  }

  if (COLLECTION_URL.test(url) || /\b(collection|catalog|all products)\b/i.test(`${title} ${content}`)) {
    return {
      doc_type: DOC_TYPE.CATEGORY,
      entity_type: null,
      confidence: "low",
      reason: "catalog_keywords",
    };
  }

  return {
    doc_type: DOC_TYPE.KNOWLEDGE,
    entity_type: null,
    confidence: "low",
    reason: "default_knowledge",
  };
}

/**
 * Rough count of distinct product-like lines for multi-entity pages.
 */
function extractEntityCandidates(content, title = "") {
  const lines = `${title}\n${content}`.split(/\n+/);
  const candidates = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 8) continue;
    const hasSize = /\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(trimmed);
    const hasPrice = PRICE_PATTERN.test(trimmed);
    if (hasSize || hasPrice) {
      candidates.push(trimmed);
    }
  }
  return candidates;
}

module.exports = {
  classifyDocument,
  inferEntityType,
  extractEntityCandidates,
  PRODUCT_URL,
  COLLECTION_URL,
};
