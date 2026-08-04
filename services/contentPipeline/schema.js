/**
 * Phase 0 contracts: common page schema + Qdrant chunk payload shape.
 * Keep user_id / agent_id naming for existing QueryController filters.
 */

const PIPELINE_VERSION = "pc_hybrid_tiktoken_v1";

const PAGE_TYPES = Object.freeze([
  "product",
  "faq",
  "docs",
  "blog",
  "generic",
]);

const ENTITY_TYPES = Object.freeze([
  "product",
  "listing",
  "faq",
  "job_posting",
  "service",
  "blog_post",
  "policy",
  "docs",
  "about",
  "review",
  "general",
]);

const URL_PIPELINE_STATUS = Object.freeze({
  DISCOVERED: "discovered",
  QUEUED: "queued",
  FETCHED: "fetched",
  PROCESSED: "processed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/**
 * @typedef {Object} NormalizedPage
 * @property {string} url
 * @property {string} user_id
 * @property {string} [agent_id]
 * @property {string} pageType
 * @property {string} entity_type
 * @property {string|null} entity_name
 * @property {string} text
 * @property {string} title
 * @property {string} metaDescription
 * @property {string|null} canonicalUrl
 * @property {string} language
 * @property {Object} attributes
 * @property {number} classification_confidence
 * @property {string} classification_reason
 * @property {number|null} quality_score
 * @property {string|null} content_hash
 * @property {boolean} is_active
 */

/**
 * Build one Qdrant point payload from a normalized page + chunk.
 * Embedding context prefix must NOT be included in `text`.
 */
function buildQdrantChunkPayload(page, chunk, { chunkIndex, totalChunks }) {
  const now = new Date().toISOString();
  const pageType = page.pageType || "generic";
  const entityType = page.entity_type || "general";

  return {
    url: page.url,
    user_id: page.user_id?.toString?.() ?? String(page.user_id || ""),
    agent_id: page.agent_id != null ? String(page.agent_id) : undefined,

    pageType,
    entity_type: entityType,
    entity_name: page.entity_name ?? null,
    product_id: page.product_id ?? null,

    text: chunk,
    parent_text: page.parent_text ?? null,
    parent_id: page.parent_id ?? null,
    parent_index:
      typeof page.parent_index === "number" ? page.parent_index : null,
    child_index:
      typeof page.child_index === "number" ? page.child_index : chunkIndex,
    chunk_role: page.chunk_role || "child",
    pipeline_version: page.pipeline_version || PIPELINE_VERSION,

    heading_path: page.heading_path || "",
    title: page.title || "",
    metaDescription: page.metaDescription || "",
    language: page.language || "en",

    search_terms: page.search_terms || [],
    attributes: page.attributes && typeof page.attributes === "object"
      ? page.attributes
      : {},

    chunk_index: chunkIndex,
    total_chunks: totalChunks,

    classification_confidence:
      typeof page.classification_confidence === "number"
        ? page.classification_confidence
        : 0,
    classification_reason: page.classification_reason || "phase1_generic",
    quality_score:
      typeof page.quality_score === "number" ? page.quality_score : null,

    content_hash: page.content_hash || null,
    created_at: now,
    updated_at: now,
    is_active: page.is_active !== false,

    // Compat with existing retrieval / filters
    source_type: page.source_type || pageType,
    type: page.type !== undefined ? page.type : 0,
  };
}

module.exports = {
  PIPELINE_VERSION,
  PAGE_TYPES,
  ENTITY_TYPES,
  URL_PIPELINE_STATUS,
  buildQdrantChunkPayload,
};
