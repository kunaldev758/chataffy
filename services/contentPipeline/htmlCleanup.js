const cheerio = require("cheerio");
const urlModule = require("url");

const FOOTER_SELECTORS =
  "footer, [role='contentinfo'], #footer, #colophon, .site-footer, .page-footer";

const HEADER_SELECTORS = [
  "header",
  "[role='banner']",
  "#header",
  ".site-header",
  "#masthead",
  ".page-header",
  "[class*='site-header']",
  "nav",
  "[role='navigation']",
  "#nav",
  "#navigation",
  ".navigation",
  ".navbar",
  ".nav-bar",
  ".main-nav",
  ".main-menu",
  ".top-nav",
  ".top-bar",
  ".menu-bar",
  "#menu",
].join(", ");

/**
 * Collection / catalog filter sidebars (Shopify facets, etc.).
 * These are navigation chrome — not FAQ or product prose for RAG.
 */
const FACET_SIDEBAR_SELECTORS = [
  "aside",
  "[role='complementary']",
  ".sidebar",
  ".side-bar",
  "#sidebar",
  ".facets",
  ".facet",
  ".filters",
  ".filter-group",
  ".collection-filters",
  ".collection-sidebar",
  "[class*='facet-']",
  "[class*='Facet']",
  "[id*='FacetFilters']",
  "[id*='Facet-']",
  "[class*='filter-sidebar']",
  "[class*='filters-drawer']",
  "[class*='collection-filter']",
  "[class*='facets__']",
  "facet-filters-form",
  "facet-filters",
  ".facets-container",
  ".product-filters",
  "[data-facets]",
].join(", ");

/**
 * PDP body containers — description, specs, tabs (keep these for primary extract).
 * Used by extractCleanProductBody + residual covered marking.
 */
const PRODUCT_BODY_SELECTORS = [
  "[itemprop='description']",
  ".product__description",
  ".product-description",
  ".product-single__description",
  ".product__content",
  ".product-content",
  ".product-detail",
  ".product-details",
  ".product__details",
  ".product-detail__description",
  ".product-info-main",
  ".product__info-description",
  ".product-tabs",
  ".product__tabs",
  ".product-tab-content",
  "[class*='product-description']",
  "[class*='ProductDescription']",
  "[id*='ProductDescription']",
  "[id*='product-description']",
  ".rte",
  ".product .rte",
  "main .product",
  "[itemtype*='Product']",
].join(", ");

/** Blocks to strip from PDP primary body (owned by residual / FAQ extractors). */
const PRODUCT_BODY_EXCLUDE_SELECTORS = [
  "[itemtype*='FAQPage']",
  ".faq",
  ".faqs",
  "#faq",
  "#faqs",
  "[class*='faq-section']",
  "[id*='faq']",
  ".reviews",
  "#reviews",
  ".product-reviews",
  "[class*='review']",
  "[itemtype*='Review']",
  "[itemtype*='AggregateRating']",
  ".related",
  ".related-products",
  "[class*='related-product']",
  ".recommendations",
  "[class*='recommend']",
  "[class*='upsell']",
  "[class*='cross-sell']",
  ".recently-viewed",
  "[class*='recently-viewed']",
  "[class*='newsletter']",
  "[id*='newsletter']",
  ".popup",
  ".modal",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='consent']",
].join(", ");

const SOCIAL_PLATFORM_LABELS = [
  { pattern: /facebook\.com/i, label: "Facebook" },
  { pattern: /instagram\.com/i, label: "Instagram" },
  { pattern: /twitter\.com|x\.com/i, label: "Twitter / X" },
  { pattern: /youtube\.com/i, label: "YouTube" },
  { pattern: /tiktok\.com/i, label: "TikTok" },
  { pattern: /linkedin\.com/i, label: "LinkedIn" },
  { pattern: /pinterest\.com/i, label: "Pinterest" },
];

function isInlineBufferImageUrl(value) {
  return typeof value === "string" && /^(data:|blob:)/i.test(value.trim());
}

/** Drop inline data/blob image payloads from scraped text before Qdrant indexing. */
function stripInlineBufferImageContent(text) {
  if (!text) return text;

  const inlineImageUrlPattern = String.raw`\b(?:data|blob):[^\s)\]"]+`;

  return text
    .replace(/!\[[^\]]*]\((?:data|blob):[^)]+\)/gi, "")
    .replace(
      new RegExp(`Image\\s*\\([^)]*\\):\\s*${inlineImageUrlPattern}`, "gi"),
      (match) => {
        const altMatch = match.match(/^Image\s*\(([^)]*)\)/i);
        return altMatch?.[1]?.trim() ? `Image (${altMatch[1].trim()})` : "";
      },
    )
    .replace(new RegExp(`Image:\\s*${inlineImageUrlPattern}`, "gi"), "")
    .replace(new RegExp(inlineImageUrlPattern, "gi"), "");
}

function getDomainChromeState(chromeCache, domain) {
  if (!chromeCache[domain]) {
    chromeCache[domain] = { headerCaptured: false, footerCaptured: false };
  }
  return chromeCache[domain];
}

function extractChromeHtml($, selectors) {
  const topLevel = $(selectors)
    .toArray()
    .filter((el) => $(el).parents(selectors).length === 0);

  if (!topLevel.length) return "";
  return topLevel
    .map((el) => $.html(el))
    .join("\n")
    .trim();
}

/** Label icon-only footer links so RAG can match platform names. */
function enrichFooterHtml(footerHTML) {
  if (!footerHTML) return footerHTML;
  const $ = cheerio.load(footerHTML, { decodeEntities: true });

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href) return;

    for (const { pattern, label } of SOCIAL_PLATFORM_LABELS) {
      if (pattern.test(href)) {
        $(el).empty().text(`${label}: ${href}`);
        return;
      }
    }

    if (href.startsWith("mailto:")) {
      const email = href.replace(/^mailto:/i, "").split("?")[0];
      if (email) $(el).text(`Email: ${email}`);
      return;
    }

    if (href.startsWith("tel:")) {
      const phone = href.replace(/^tel:/i, "");
      if (phone) $(el).text(`Phone: ${phone}`);
    }
  });

  return $.root().html() || footerHTML;
}

/**
 * In-place DOM cleanup before markdown conversion.
 * @returns {{ headerHTML: string, footerHTML: string }}
 */
function cleanupHtmlDom($, webPageURL, { isHomepage, chromeState } = {}) {
  $(
    "script, style, noscript, iframe, svg, canvas, form, input, button, select, textarea",
  ).remove();
  $(".ad, .advertisement, .popup, .modal").remove();
  // Common cookie / consent banners (best-effort; Phase 2 can expand)
  $(
    "[id*='cookie'], [class*='cookie'], [id*='consent'], [class*='consent'], #onetrust-banner-sdk, .cc-window",
  ).remove();
  // Collection filter / facet sidebars (not useful as RAG prose)
  $(FACET_SIDEBAR_SELECTORS).remove();

  $("a, img").each((_, el) => {
    const attr = $(el).is("a") ? "href" : "src";
    const val = $(el).attr(attr);
    if (val && !val.startsWith("http") && !val.startsWith("data:")) {
      $(el).attr(attr, urlModule.resolve(webPageURL, val));
    }
  });

  let headerHTML = "";
  let footerHTML = "";

  if (isHomepage && chromeState) {
    if (!chromeState.headerCaptured) {
      headerHTML = extractChromeHtml($, HEADER_SELECTORS);
      if (headerHTML) chromeState.headerCaptured = true;
    }
    if (!chromeState.footerCaptured) {
      footerHTML = extractChromeHtml($, FOOTER_SELECTORS);
      if (footerHTML) chromeState.footerCaptured = true;
    }
  }

  $(HEADER_SELECTORS).remove();
  $(FOOTER_SELECTORS).remove();

  $("img").each((_, el) => {
    const src = $(el).attr("src")?.trim();
    const alt = $(el).attr("alt")?.trim();

    if (!src || isInlineBufferImageUrl(src)) {
      if (alt) {
        $(el).replaceWith(`<p>Image (${alt})</p>`);
      } else {
        $(el).remove();
      }
      return;
    }

    const altText = alt ? ` (${alt})` : "";
    $(el).replaceWith(`<p>Image${altText}: ${src}</p>`);
  });

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && !text) {
      $(el).text(`Link: ${href}`);
    }
  });

  $("*").each((_, el) => {
    const text = $(el).text().trim();
    if (!text && $(el).children().length === 0) {
      $(el).remove();
    }
  });

  return { headerHTML, footerHTML };
}

/**
 * Extract cleaned product page body markdown for PDP primary content.
 * Strips chrome / facets / FAQ / reviews / related; keeps description, specs,
 * materials, care, size guide, shipping/returns when present on the page.
 *
 * @param {string} html
 * @param {string} [pageUrl]
 * @returns {{ markdown: string, source: string|null }}
 */
function extractCleanProductBody(html, pageUrl = "") {
  if (!html || typeof html !== "string") {
    return { markdown: "", source: null };
  }

  try {
    const TurndownService = require("turndown");
    const $ = cheerio.load(html);

    $("script, style, noscript, iframe, svg, template").remove();
    $(HEADER_SELECTORS).remove();
    $(FOOTER_SELECTORS).remove();
    $(FACET_SIDEBAR_SELECTORS).remove();
    $(PRODUCT_BODY_EXCLUDE_SELECTORS).remove();
    $(
      "[id*='cookie'], [class*='cookie'], [id*='consent'], [class*='consent'], #onetrust-banner-sdk, .cc-window, .popup, .modal, .advertisement, .ad",
    ).remove();

    // Absolute-ize links for RAG
    if (pageUrl) {
      $("a, img").each((_, el) => {
        const attr = $(el).is("a") ? "href" : "src";
        const val = $(el).attr(attr);
        if (val && !val.startsWith("http") && !val.startsWith("data:") && !val.startsWith("#")) {
          try {
            $(el).attr(attr, urlModule.resolve(pageUrl, val));
          } catch {
            /* ignore */
          }
        }
      });
    }

    // Drop data:/blob: images; keep alt text when useful
    $("img").each((_, el) => {
      const src = $(el).attr("src")?.trim();
      const alt = $(el).attr("alt")?.trim();
      if (!src || isInlineBufferImageUrl(src)) {
        if (alt) $(el).replaceWith(`<p>Image (${alt})</p>`);
        else $(el).remove();
      }
    });

    const turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
    });

    const preferredSelectors = [
      "[itemprop='description']",
      ".product__description",
      ".product-description",
      ".product-single__description",
      ".product__content",
      ".product-content",
      ".product-detail__description",
      ".product__info-description",
      "[class*='product-description']",
      "[class*='ProductDescription']",
      "[id*='ProductDescription']",
      "[id*='product-description']",
      ".product-tabs",
      ".product__tabs",
      ".product-tab-content",
      ".rte",
      ".product .rte",
    ];

    const fallbackSelectors = [
      ".product-detail",
      ".product-details",
      ".product__details",
      ".product-info-main",
      "main .product",
      "[itemtype*='Product']",
      "main [class*='product']",
      "main, [role='main']",
      "article",
      "body",
    ];

    const pickBest = (selectorList) => {
      let bestHtml = "";
      let bestSource = null;
      let bestLen = 0;
      for (const selector of selectorList) {
        const nodes = $(selector)
          .toArray()
          .filter((el) => $(el).parents(selector).length === 0);
        for (const el of nodes) {
          const inner = $(el).html() || "";
          const textLen = $(el).text().replace(/\s+/g, " ").trim().length;
          if (textLen > bestLen && textLen >= 40) {
            bestLen = textLen;
            bestHtml = inner;
            bestSource = selector;
          }
        }
      }
      return { bestHtml, bestSource, bestLen };
    };

    let { bestHtml, bestSource, bestLen } = pickBest(preferredSelectors);
    if (bestLen < 120) {
      const fallback = pickBest(fallbackSelectors);
      if (fallback.bestLen > bestLen) {
        bestHtml = fallback.bestHtml;
        bestSource = fallback.bestSource;
        bestLen = fallback.bestLen;
      }
    }

    if (!bestHtml) {
      return { markdown: "", source: null };
    }

    const markdown = stripInlineBufferImageContent(
      turndown
        .turndown(bestHtml)
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );

    return {
      markdown: markdown.length >= 40 ? markdown : "",
      source: markdown.length >= 40 ? bestSource : null,
    };
  } catch (err) {
    console.warn(`[htmlCleanup] extractCleanProductBody failed: ${err.message}`);
    return { markdown: "", source: null };
  }
}

module.exports = {
  FOOTER_SELECTORS,
  HEADER_SELECTORS,
  FACET_SIDEBAR_SELECTORS,
  PRODUCT_BODY_SELECTORS,
  PRODUCT_BODY_EXCLUDE_SELECTORS,
  isInlineBufferImageUrl,
  stripInlineBufferImageContent,
  getDomainChromeState,
  extractChromeHtml,
  enrichFooterHtml,
  cleanupHtmlDom,
  extractCleanProductBody,
};
