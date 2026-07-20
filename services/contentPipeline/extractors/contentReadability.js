const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const { stripInlineBufferImageContent } = require("../htmlCleanup");

/**
 * Readability-based extraction for blog / FAQ / docs content pages.
 * Falls back to null when article content is too thin (caller uses generic).
 */
function extractWithReadability(url, html) {
  if (!html || typeof html !== "string") {
    return null;
  }

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.content) {
      return null;
    }

    const textContent = (article.textContent || "").trim();
    if (textContent.length < 80) {
      return null;
    }

    const turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
    });

    let markdown = turndown.turndown(article.content);
    if (article.title) {
      markdown = `# ${article.title}\n\n${markdown}`;
    }

    markdown = stripInlineBufferImageContent(
      markdown
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );

    if (markdown.length < 80) return null;

    return {
      content: markdown,
      entity_name: article.title || null,
      extraction_confidence: 0.8,
      extraction_source: "readability",
      excerpt: article.excerpt || null,
    };
  } catch (err) {
    console.warn(
      `[contentPipeline] Readability failed for ${url}: ${err.message}`,
    );
    return null;
  }
}

module.exports = {
  extractWithReadability,
};
