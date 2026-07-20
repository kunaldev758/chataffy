const crypto = require("crypto");
const { buildQdrantChunkPayload } = require("./schema");

function hashContent(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
}

/**
 * Normalize extracted page content into the Phase 0 common page schema.
 * Phase 1 defaults: pageType=generic, entity_type=general (no LLM / typed extract yet).
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
 * Turn a normalized page into LangChain-style docs for QdrantService.upsertDocuments.
 */
function pageToUpsertDocuments(page, chunks) {
  const total = chunks.length;
  return chunks.map((chunkText, index) => {
    const payload = buildQdrantChunkPayload(page, chunkText, {
      chunkIndex: index,
      totalChunks: total,
    });
    const { text, ...metadata } = payload;
    return {
      pageContent: text,
      metadata,
    };
  });
}

module.exports = {
  hashContent,
  normalizeToCommonSchema,
  pageToUpsertDocuments,
};
