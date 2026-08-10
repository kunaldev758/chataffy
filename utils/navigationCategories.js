/**
 * Homepage / nav category extraction for catalog-structure answers.
 * Kept separate from product listing and PDP extraction.
 */

const NAVIGATION_LINK_SELECTORS =
  "nav a, header a, .navbar a, .main-menu a, .navigation a, [role='navigation'] a";

const NON_CATEGORY_LABEL =
  /^(home|about(?:\s+us)?|contact(?:\s+us)?|blog|login|log\s+in|sign\s+up|sign\s+in|register|cart|bag|basket|checkout|search|account|profile|wishlist|track\s+(?:my\s+)?order)$/i;

const NON_CATEGORY_PATH =
  /\/(?:cart|checkout|account|login|register|search|wishlist)(?:\/|$)/i;

function toAbsoluteNavigationUrl(href, pageUrl) {
  if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(String(href).trim())) {
    return null;
  }

  try {
    const absolute = new URL(href, pageUrl);
    const page = new URL(pageUrl);
    if (
      !/^https?:$/.test(absolute.protocol) ||
      absolute.hostname !== page.hostname
    ) {
      return null;
    }
    absolute.hash = "";
    return absolute.toString();
  } catch {
    return null;
  }
}

/**
 * @param {import("cheerio").CheerioAPI} $
 * @param {string} pageUrl
 * @returns {{ name: string, url: string }[]}
 */
function extractNavigationCategories($, pageUrl) {
  const categories = [];
  const seen = new Set();

  $(NAVIGATION_LINK_SELECTORS).each((_, el) => {
    const name = $(el).text().replace(/\s+/g, " ").trim();
    const url = toAbsoluteNavigationUrl($(el).attr("href"), pageUrl);

    if (
      !name ||
      !url ||
      name.length > 60 ||
      NON_CATEGORY_LABEL.test(name) ||
      NON_CATEGORY_PATH.test(new URL(url).pathname)
    ) {
      return;
    }

    const key = `${name.toLowerCase()}|${url.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    categories.push({ name, url });
  });

  return categories.slice(0, 30);
}

/**
 * Synthetic Qdrant document for PAGE_LINKS / category-list answers.
 * @param {string} baseUrl
 * @param {{ name: string, url: string }[]} categories
 */
function buildNavigationDocument(baseUrl, categories) {
  if (!Array.isArray(categories) || categories.length === 0) return null;

  let navigationUrl;
  try {
    navigationUrl = new URL("#navigation-menu", baseUrl).toString();
  } catch {
    return null;
  }

  const categoryLines = categories.map(
    ({ name, url }) => `- ${name} (${url})`,
  );
  const content = [
    "# Website Navigation Menu and Catalog Collections",
    "",
    "Official navigation categories and collection pages. Use these when visitors ask for collections, categories, catalog, catalogue, navbar, menu, or departments. These are navigation destinations, not individual product recommendations.",
    "",
    ...categoryLines,
  ].join("\n");

  return {
    type: 0,
    content,
    dataSize: Buffer.byteLength(content, "utf8"),
    metadata: {
      url: navigationUrl,
      title: "Website Navigation Menu and Catalog Collections",
      metaDescription:
        "Official website navigation categories and collection links.",
      canonicalUrl: navigationUrl,
      language: "en",
      pageType: "generic",
      entity_type: "category_list",
      entity_name: "Navigation Menu and Categories",
      attributes: {
        categories: categories.map(({ name }) => name),
      },
      search_terms: [
        "navigation",
        "navbar",
        "menu",
        "catalog",
        "catalogue",
        "category",
        "categories",
        "collection",
        "collections",
      ],
      classification_confidence: 1,
      classification_reason: "synthetic_navigation_metadata",
      extraction_source: "navigation_links",
      type: "webpage",
      synthetic_navigation: true,
    },
    originalUrl: navigationUrl,
  };
}

module.exports = {
  extractNavigationCategories,
  buildNavigationDocument,
};
