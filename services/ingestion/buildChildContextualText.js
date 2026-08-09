/**
 * Build embedding-only contextualText for a child chunk.
 * Hierarchy: Page → Section → Chunk Summary → Product Attrs → body
 */
function buildChildContextualText({
  pageTitle = "",
  heading_path = "",
  summary = "",
  attrLine = "",
  body = "",
} = {}) {
  const parts = [];
  if (pageTitle) parts.push(`[Page: ${pageTitle}]`);
  if (heading_path) parts.push(`[Section: ${heading_path}]`);
  if (summary) parts.push(`[Chunk Summary: ${summary}]`);
  if (attrLine) parts.push(`[Product Attrs: ${attrLine}]`);

  const header = parts.join("\n");
  const cleanBody = String(body || "").trim();
  if (!header) return cleanBody;
  if (!cleanBody) return header;
  return `${header}\n\n${cleanBody}`;
}

module.exports = { buildChildContextualText };
