/**
 * Build an embedding-only context prefix.
 * Prefix is prepended for embedDocuments input ONLY — never stored as payload.text.
 */

function buildContextPrefix(page = {}, chunkMeta = {}) {
  const parts = [];

  const pageType = page.pageType || page.source_type;
  if (pageType) parts.push(`type:${pageType}`);

  if (page.entity_type && page.entity_type !== "general") {
    parts.push(`entity:${page.entity_type}`);
  }

  if (page.entity_name) {
    parts.push(`name:${String(page.entity_name).slice(0, 120)}`);
  } else if (page.title) {
    parts.push(`title:${String(page.title).slice(0, 120)}`);
  }

  const heading = chunkMeta.heading_path || page.heading_path;
  if (heading) {
    parts.push(`section:${String(heading).slice(0, 160)}`);
  }

  const attrs = page.attributes || {};
  if (attrs.sku) parts.push(`sku:${attrs.sku}`);
  if (attrs.brand) parts.push(`brand:${attrs.brand}`);
  if (attrs.price != null) {
    const cur = attrs.currency ? ` ${attrs.currency}` : "";
    parts.push(`price:${attrs.price}${cur}`);
  }

  if (page.language && page.language !== "en") {
    parts.push(`lang:${page.language}`);
  }

  if (!parts.length) return "";
  return `[${parts.join(" | ")}]`;
}

/**
 * @returns {string} text sent to the embedding model
 */
function applyEmbeddingPrefix(chunkText, page, chunkMeta = {}) {
  const prefix = buildContextPrefix(page, chunkMeta);
  const body = String(chunkText || "").trim();
  if (!prefix) return body;
  return `${prefix}\n\n${body}`;
}

module.exports = {
  buildContextPrefix,
  applyEmbeddingPrefix,
};
