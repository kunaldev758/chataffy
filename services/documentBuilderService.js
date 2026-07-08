/**
 * Build index-ready documents from classified crawl content.
 * Returns one or more { pageContent, metadata } records per source page.
 */

const { DOC_TYPE } = require("../constants/contentTypes");
const { classifyDocument } = require("./contentClassifier");
const { detectEntityTypes } = require("./entityTypeDetector");
const {
  extractEntities,
  formatEntityPageContent,
} = require("./entityExtractor");

/**
 * Run the Entity Extraction Engine for a single document. A page can match
 * multiple entity types (product | faq | contact | service | category).
 * Callers that already computed these may pass them in via metadata.entity_type.
 * @returns {string[]|null}
 */
function resolvePageEntityTypes(doc) {
  const incoming = doc?.metadata?.entity_type;
  if (Array.isArray(incoming) && incoming.length > 0) return incoming;

  const detected = detectEntityTypes({
    url: doc?.metadata?.url || doc?.originalUrl || "",
    title: doc?.metadata?.title || "",
    content: doc?.content || "",
    metaDescription: doc?.metadata?.metaDescription || "",
  });

  return detected.length > 0 ? detected : null;
}

function baseMetadata(doc, classification, pageTypes) {
  // Page-level entity types from the Entity Extraction Engine take precedence
  // (a page can have multiple), otherwise fall back to the single
  // classifier-inferred entity type.
  return {
    ...(doc.metadata || {}),
    doc_type: classification.doc_type,
    entity_type: pageTypes || classification.entity_type || null,
    classification_reason: classification.reason,
    classification_confidence: classification.confidence,
    source_training_type: doc.type,
  };
}

function buildEntityDocuments(doc, classification, pageTypes) {
  const url = doc.metadata?.url || doc.originalUrl || "";
  const title = doc.metadata?.title || "";
  const entities = extractEntities({
    content: doc.content,
    title,
    url,
    entity_type: classification.entity_type,
  });

  if (entities.length === 0) {
    return [
      {
        pageContent: doc.content,
        metadata: {
          ...baseMetadata(doc, { ...classification, doc_type: DOC_TYPE.KNOWLEDGE }, pageTypes),
          doc_type: DOC_TYPE.KNOWLEDGE,
          entity_type: pageTypes || null,
        },
      },
    ];
  }

  return entities.map((entity, index) => ({
    pageContent: formatEntityPageContent(entity),
    metadata: {
      ...baseMetadata(doc, classification, pageTypes),
      doc_type: DOC_TYPE.ENTITY,
      entity_type: pageTypes || entity.entity_type,
      entity_name: entity.name,
      entity_index: index,
      entity_count: entities.length,
      attributes: entity.attributes,
      sizes: entity.attributes?.sizes || [],
      collections: entity.attributes?.collection
        ? [entity.attributes.collection]
        : [],
      url: entity.url || url,
      title: entity.name,
      source_type: "product",
    },
  }));
}

function buildCategoryDocument(doc, classification, pageTypes) {
  const title = doc.metadata?.title || "Category";
  const url = doc.metadata?.url || doc.originalUrl || "";
  const header = `Category: ${title}\nURL: ${url}\n\n`;

  return [
    {
      pageContent: `${header}${doc.content}`,
      metadata: {
        ...baseMetadata(doc, classification, pageTypes),
        doc_type: DOC_TYPE.CATEGORY,
        source_type: "page",
      },
    },
  ];
}

function buildKnowledgeDocuments(doc, classification, pageTypes) {
  return [
    {
      pageContent: doc.content,
      metadata: {
        ...baseMetadata(doc, classification, pageTypes),
        doc_type: DOC_TYPE.KNOWLEDGE,
        source_type:
          doc.metadata?.type === "faq"
            ? "page"
            : doc.metadata?.source_type || "page",
      },
    },
  ];
}

/**
 * @param {{ type?: number, content: string, metadata?: object, originalUrl?: string }} doc
 * @returns {{ pageContent: string, metadata: object }[]}
 */
function buildDocuments(doc) {
  if (!doc?.content?.trim()) return [];

  const classification = classifyDocument(doc);
  const pageTypes = resolvePageEntityTypes(doc);

  switch (classification.doc_type) {
    case DOC_TYPE.ENTITY:
      return buildEntityDocuments(doc, classification, pageTypes);
    case DOC_TYPE.CATEGORY:
      return buildCategoryDocument(doc, classification, pageTypes);
    case DOC_TYPE.KNOWLEDGE:
    default:
      return buildKnowledgeDocuments(doc, classification, pageTypes);
  }
}

module.exports = {
  buildDocuments,
  buildEntityDocuments,
  buildCategoryDocument,
  buildKnowledgeDocuments,
};
