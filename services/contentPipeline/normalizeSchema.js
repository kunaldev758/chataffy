const crypto = require("crypto");
const { buildQdrantChunkPayload, PIPELINE_VERSION } = require("./schema");
const { applyEmbeddingPrefix } = require("./contextPrefix");

function hashContent(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
}

/**
 * Normalize extracted page content into the common page schema.
 */
function normalizeToCommonSchema({
  url,
  userId,
  agentId,
  content,
  title = "",
  metaDescription = "",
  canonicalUrl = null,
  language = "en",
  pageType = "generic",
  entity_type = "general",
  entity_name = null,
  attributes = {},
  search_terms = [],
  classification_confidence = 0,
  classification_reason = "phase3",
  quality_score = null,
  type = 0,
}) {
  const text = String(content || "").trim();
  const content_hash = text ? hashContent(text) : null;

  return {
    url,
    user_id: userId?.toString?.() ?? String(userId || ""),
    agent_id: agentId != null ? String(agentId) : undefined,
    pageType,
    entity_type,
    entity_name,
    text,
    heading_path: "",
    title: title || url,
    metaDescription: metaDescription || "",
    canonicalUrl: canonicalUrl || null,
    language: language || "en",
    attributes:
      attributes && typeof attributes === "object" ? { ...attributes } : {},
    search_terms: Array.isArray(search_terms) ? [...search_terms] : [],
    classification_confidence,
    classification_reason,
    quality_score,
    content_hash,
    is_active: true,
    source_type: pageType,
    type,
  };
}

/**
 * Normalize chunk list to { text, heading_path, ...sectionOverrides }[].
 * Accepts plain strings (legacy) or chunk objects.
 */
function normalizeChunkList(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks
    .map((c) => {
      if (typeof c === "string") {
        return { text: c, heading_path: "" };
      }
      if (c && typeof c === "object") {
        return {
          text: String(c.text || c.pageContent || "").trim(),
          heading_path: c.heading_path || "",
          pageType: c.pageType,
          entity_type: c.entity_type,
          entity_name: c.entity_name,
          product_id: c.product_id,
          attributes: c.attributes,
          search_terms: c.search_terms,
          classification_confidence: c.classification_confidence,
          classification_reason: c.classification_reason,
          quality_score: c.quality_score,
          parent_text: c.parent_text,
          parent_id: c.parent_id,
          parent_index: c.parent_index,
          child_index: c.child_index,
          chunk_role: c.chunk_role,
        };
      }
      return null;
    })
    .filter((c) => c && c.text);
}

/**
 * Build LangChain-style docs for QdrantService.upsertDocuments.
 * - pageContent / payload.text = clean chunk (NO prefix)
 * - metadata.embeddingText = prefixed string for embed only
 * Chunk-level entity_type / attributes override page defaults (multi-section).
 */
function pageToUpsertDocuments(page, chunks) {
  const normalized = normalizeChunkList(chunks);
  const total = normalized.length;

  return normalized.map((chunk, index) => {
    const pageForChunk = {
      ...page,
      heading_path: chunk.heading_path || "",
      pageType: chunk.pageType || page.pageType,
      entity_type: chunk.entity_type || page.entity_type,
      entity_name:
        chunk.entity_name !== undefined && chunk.entity_name !== null
          ? chunk.entity_name
          : page.entity_name,
      product_id:
        chunk.product_id !== undefined && chunk.product_id !== null
          ? chunk.product_id
          : page.product_id,
      attributes:
        chunk.attributes && typeof chunk.attributes === "object"
          ? chunk.attributes
          : page.attributes,
      search_terms: Array.isArray(chunk.search_terms)
        ? chunk.search_terms
        : page.search_terms,
      classification_confidence:
        typeof chunk.classification_confidence === "number"
          ? chunk.classification_confidence
          : page.classification_confidence,
      classification_reason:
        chunk.classification_reason || page.classification_reason,
      quality_score:
        typeof chunk.quality_score === "number"
          ? chunk.quality_score
          : page.quality_score,
      source_type: chunk.pageType || page.source_type || page.pageType,
      parent_text: chunk.parent_text || chunk.text,
      parent_id: chunk.parent_id || null,
      parent_index:
        typeof chunk.parent_index === "number" ? chunk.parent_index : null,
      child_index:
        typeof chunk.child_index === "number" ? chunk.child_index : index,
      chunk_role: chunk.chunk_role || "child",
      pipeline_version: page.pipeline_version || PIPELINE_VERSION,
    };
    const payload = buildQdrantChunkPayload(pageForChunk, chunk.text, {
      chunkIndex: index,
      totalChunks: total,
    });
    const embeddingText = applyEmbeddingPrefix(chunk.text, pageForChunk, {
      heading_path: chunk.heading_path,
    });

    // Sparse lexical signal: child text + title/sku (no embed prefix)
    const sparseText = chunk.text;
    const sparseBoost = {
      title: pageForChunk.title,
      sku: pageForChunk.attributes?.sku,
      url: pageForChunk.url,
    };

    const { text, ...metadata } = payload;
    return {
      pageContent: text,
      metadata: {
        ...metadata,
        heading_path: chunk.heading_path || "",
        embeddingText,
        sparseText,
        sparseBoost,
      },
    };
  });
}

module.exports = {
  hashContent,
  normalizeToCommonSchema,
  normalizeChunkList,
  pageToUpsertDocuments,
};
