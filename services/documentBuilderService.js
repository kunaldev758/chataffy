/**
 * Build index-ready documents from classified crawl content.
 * Returns one or more { pageContent, metadata } records per source page.
 */

const { DOC_TYPE } = require("../constants/contentTypes");
const { classifyDocument } = require("./contentClassifier");
const {
  extractEntities,
  formatEntityPageContent,
} = require("./entityExtractor");

function baseMetadata(doc, classification) {
  return {
    ...(doc.metadata || {}),
    doc_type: classification.doc_type,
    entity_type: classification.entity_type || null,
    classification_reason: classification.reason,
    classification_confidence: classification.confidence,
    source_training_type: doc.type,
  };
}

function buildEntityDocuments(doc, classification) {
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
          ...baseMetadata(doc, { ...classification, doc_type: DOC_TYPE.KNOWLEDGE }),
          doc_type: DOC_TYPE.KNOWLEDGE,
          entity_type: null,
        },
      },
    ];
  }

  return entities.map((entity, index) => ({
    pageContent: formatEntityPageContent(entity),
    metadata: {
      ...baseMetadata(doc, classification),
      doc_type: DOC_TYPE.ENTITY,
      entity_type: entity.entity_type,
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

function buildCategoryDocument(doc, classification) {
  const title = doc.metadata?.title || "Category";
  const url = doc.metadata?.url || doc.originalUrl || "";
  const header = `Category: ${title}\nURL: ${url}\n\n`;

  return [
    {
      pageContent: `${header}${doc.content}`,
      metadata: {
        ...baseMetadata(doc, classification),
        doc_type: DOC_TYPE.CATEGORY,
        source_type: "page",
      },
    },
  ];
}

function buildKnowledgeDocuments(doc, classification) {
  return [
    {
      pageContent: doc.content,
      metadata: {
        ...baseMetadata(doc, classification),
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

  switch (classification.doc_type) {
    case DOC_TYPE.ENTITY:
      return buildEntityDocuments(doc, classification);
    case DOC_TYPE.CATEGORY:
      return buildCategoryDocument(doc, classification);
    case DOC_TYPE.KNOWLEDGE:
    default:
      return buildKnowledgeDocuments(doc, classification);
  }
}

module.exports = {
  buildDocuments,
  buildEntityDocuments,
  buildCategoryDocument,
  buildKnowledgeDocuments,
};
