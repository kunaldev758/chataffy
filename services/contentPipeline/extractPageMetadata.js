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
      const seen = new WeakSet();
      const collect = (node) => {
        if (!node || typeof node !== "object") return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        const t = node["@type"];
        const pushType = (rawType) => {
          if (typeof rawType !== "string") return;
          const key = rawType
            .toLowerCase()
            .replace(/^https?:\/\/schema\.org\//, "")
            .replace(/^schema\.org\//, "")
            .trim();
          if (key) schemaTypes.push(key);
        };
        if (typeof t === "string") pushType(t);
        else if (Array.isArray(t)) t.forEach(pushType);
        for (const [key, value] of Object.entries(node)) {
          if (key === "@context") continue;
          if (value && typeof value === "object") collect(value);
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
