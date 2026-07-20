const crypto = require("crypto");
const { buildQdrantChunkPayload } = require("./schema");
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
 * Normalize chunk list to { text, heading_path }[].
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
 */
function pageToUpsertDocuments(page, chunks) {
  const normalized = normalizeChunkList(chunks);
  const total = normalized.length;

  return normalized.map((chunk, index) => {
    const pageForChunk = {
      ...page,
      heading_path: chunk.heading_path || "",
    };
    const payload = buildQdrantChunkPayload(pageForChunk, chunk.text, {
      chunkIndex: index,
      totalChunks: total,
    });
    const embeddingText = applyEmbeddingPrefix(chunk.text, page, {
      heading_path: chunk.heading_path,
    });

    const { text, ...metadata } = payload;
    return {
      pageContent: text,
      metadata: {
        ...metadata,
        heading_path: chunk.heading_path || "",
        embeddingText,
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
