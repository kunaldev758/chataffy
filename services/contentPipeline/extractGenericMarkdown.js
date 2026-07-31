const cheerio = require("cheerio");
const TurndownService = require("turndown");
const { isHomepageUrl } = require("../../utils/webUrlUtils");
const {
  cleanupHtmlDom,
  getDomainChromeState,
  enrichFooterHtml,
  stripInlineBufferImageContent,
} = require("./htmlCleanup");
const { extractPageMetadata } = require("./extractPageMetadata");
const { extractBusinessInfoFromJsonLd } = require("./extractors/businessInfo");

/**
 * Generic Cheerio → Markdown extraction (Phase 1 default path).
 * @returns {{ content: string, title: string, metaDescription: string, canonicalUrl: string|null, language: string, pageMetadata: object, webPageURL: string }}
 */
function extractGenericMarkdown(url, sourceCode, chromeCache = {}) {
  const $ = cheerio.load(sourceCode);
  const webPageURL = url;
  const domain = new URL(webPageURL).hostname;
  const isHomepage = isHomepageUrl(webPageURL);
  const chromeState = getDomainChromeState(chromeCache, domain);

  // Metadata from a separate parse so cleanup does not strip ld+json scripts first
  const $meta = cheerio.load(sourceCode);
  const pageMetadata = extractPageMetadata($meta, url);

  const { headerHTML, footerHTML } = cleanupHtmlDom($, webPageURL, {
    isHomepage,
    chromeState,
  });

  const turndownService = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
  });

  let markdown = turndownService.turndown($("body").html() || "");

  if (headerHTML) {
    const enrichedHeader = enrichFooterHtml(headerHTML);
    const headerMarkdown = turndownService.turndown(enrichedHeader);
    markdown = `---\n**Header / Nav (from ${domain})**\n${headerMarkdown}\n\n---\n\n${markdown}`;
  }

  if (footerHTML) {
    const enrichedFooter = enrichFooterHtml(footerHTML);
    const footerMarkdown = turndownService.turndown(enrichedFooter);
    markdown += `\n\n---\n**Footer Links (from ${domain})**\n${footerMarkdown}`;
  }

  let content = stripInlineBufferImageContent(
    markdown
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );

  // Business identity/contact JSON-LD (LocalBusiness, Organization, etc.) is
  // otherwise only used for page-type classification and never indexed.
  // Capture once per domain (like header/footer) since Organization schema
  // is often duplicated site-wide and would otherwise repeat on every page.
  if (!chromeState.businessInfoCaptured) {
    const businessInfo = extractBusinessInfoFromJsonLd(pageMetadata.jsonLdBlocks);
    if (businessInfo?.content) {
      content = `${businessInfo.content}\n\n${content}`.trim();
      chromeState.businessInfoCaptured = true;
    }
  }

  return {
    content,
    webPageURL,
    title: pageMetadata.title,
    metaDescription: pageMetadata.metaDescription,
    canonicalUrl: pageMetadata.canonicalUrl,
    language: pageMetadata.language,
    pageMetadata,
  };
}

module.exports = {
  extractGenericMarkdown,
};
