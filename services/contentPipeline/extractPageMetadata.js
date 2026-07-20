const { detectWebsiteLanguage } = require("../../utils/websiteLanguage");

/**
 * Page-level metadata from raw HTML (title, meta, canonical, language, schema types).
 * Does not mutate the DOM used for content extraction — load a fresh cheerio root.
 */
function extractPageMetadata($, url) {
  const title = $("title").text().trim() || url;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || "";

  let canonicalUrl = null;
  const canonicalHref = $('link[rel="canonical"]').attr("href")?.trim();
  if (canonicalHref) {
    try {
      canonicalUrl = new URL(canonicalHref, url).toString();
    } catch (_) {
      canonicalUrl = canonicalHref;
    }
  }

  const schemaTypes = [];
  const jsonLdBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text() || $(el).text();
      const parsed = JSON.parse(raw);
      jsonLdBlocks.push(parsed);
      const collect = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (typeof node === "object") {
          const t = node["@type"];
          if (typeof t === "string") schemaTypes.push(t.toLowerCase());
          else if (Array.isArray(t)) {
            t.forEach(
              (x) =>
                typeof x === "string" && schemaTypes.push(x.toLowerCase()),
            );
          }
          if (node["@graph"]) collect(node["@graph"]);
        }
      };
      collect(parsed);
    } catch (_) {
      // ignore invalid JSON-LD
    }
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const langInfo = detectWebsiteLanguage($, bodyText);

  return {
    url,
    title,
    metaDescription,
    canonicalUrl,
    language: langInfo.primary_language || "en",
    languages: langInfo.languages || ["en"],
    language_confidence: langInfo.language_confidence,
    language_source: langInfo.language_source,
    schemaTypes: [...new Set(schemaTypes)],
    jsonLdBlocks,
  };
}

module.exports = {
  extractPageMetadata,
};
