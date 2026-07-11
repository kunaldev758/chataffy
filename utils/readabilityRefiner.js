const cheerio = require("cheerio");
const TurndownService = require("turndown");
const urlModule = require("url");

/**
 * Clean up HTML page by removing boilerplate elements.
 */
function cleanHtmlDOM($) {
  // Unwanted elements to strip completely
  $(
    "script, style, noscript, iframe, svg, canvas, form, input, button, select, textarea, " +
    "nav, header, footer, sidebar, aside, " +
    ".ad, .advertisement, .popup, .modal, .cookie-banner, .newsletter-signup, .newsletter, " +
    "#header, #footer, #sidebar, #nav, .navigation, .menu, .header, .footer, .banner"
  ).remove();

  // Remove elements that look like sharing widgets or cookie prompts
  $("*").each((_, el) => {
    const className = $(el).attr("class") || "";
    const id = $(el).attr("id") || "";
    const testStr = `${className} ${id}`.toLowerCase();
    
    if (
      testStr.includes("cookie") ||
      testStr.includes("newsletter") ||
      testStr.includes("subscribe") ||
      testStr.includes("modal") ||
      testStr.includes("popup") ||
      testStr.includes("share-buttons") ||
      testStr.includes("social-share")
    ) {
      $(el).remove();
    }
  });

  // Remove empty or redundant tags
  $("*").each((_, el) => {
    const text = $(el).text().trim();
    if (!text && $(el).children().length === 0) {
      $(el).remove();
    }
  });
}

/**
 * Standardize relative URLs for links and images.
 */
function standardizeUrls($, baseUrl) {
  $("a, img").each((_, el) => {
    const attr = $(el).is("a") ? "href" : "src";
    const val = $(el).attr(attr);
    if (val && !val.startsWith("http") && !val.startsWith("data:")) {
      try {
        $(el).attr(attr, urlModule.resolve(baseUrl, val));
      } catch (e) {
        // Ignore parsing errors
      }
    }
  });

  // Convert images to descriptive text references for Markdown
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const alt = $(el).attr("alt")?.trim();
    if (src) {
      const altText = alt ? ` (${alt})` : "";
      $(el).replaceWith(`<p>Image${altText}: ${src}</p>`);
    }
  });

  // Convert anchor-only links
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && !text) {
      $(el).text(`Link: ${href}`);
    }
  });
}

/**
 * Extract structured product metadata from cheerio representation of the page.
 */
function extractProductMetadata($, url) {
  let metadata = {
    isProduct: false,
    price: null,
    currency: "",
    imageUrl: "",
    sku: "",
    availability: "",
    brand: "",
    category: "",
  };

  // 1. JSON-LD parsing
  try {
    const jsonLdScripts = $('script[type="application/ld+json"]');
    jsonLdScripts.each((_, script) => {
      try {
        const text = $(script).html();
        if (!text) return;
        const data = JSON.parse(text);

        const parseProductNode = (node) => {
          if (!node || typeof node !== "object") return false;

          const type = String(node["@type"] || "");
          if (type === "Product" || type === "ProductModel" || node.offers) {
            metadata.isProduct = true;
            
            if (node.name) metadata.entityName = String(node.name);
            
            // Image
            if (node.image) {
              if (typeof node.image === "string") {
                metadata.imageUrl = node.image;
              } else if (Array.isArray(node.image) && node.image.length > 0) {
                metadata.imageUrl = typeof node.image[0] === "string" ? node.image[0] : (node.image[0].url || "");
              } else if (typeof node.image === "object") {
                metadata.imageUrl = node.image.url || "";
              }
            }

            // SKU
            if (node.sku) metadata.sku = String(node.sku);
            if (!metadata.sku && node.mpn) metadata.sku = String(node.mpn);

            // Brand
            if (node.brand) {
              if (typeof node.brand === "string") {
                metadata.brand = node.brand;
              } else if (typeof node.brand === "object") {
                metadata.brand = node.brand.name || "";
              }
            }

            // Category
            if (node.category) {
              metadata.category = typeof node.category === "string" ? node.category : "";
            }

            // Offers (Price, Currency, Stock)
            if (node.offers) {
              const parseOffer = (offer) => {
                if (!offer || typeof offer !== "object") return;
                
                // Price
                let priceVal = offer.price || offer.lowPrice || offer.highPrice;
                if (priceVal) {
                  const num = parseFloat(String(priceVal).replace(/[^\d.-]/g, ""));
                  if (!isNaN(num)) {
                    metadata.price = num;
                  }
                }

                // Currency
                if (offer.priceCurrency) {
                  metadata.currency = String(offer.priceCurrency).toUpperCase();
                }

                // Availability
                if (offer.availability) {
                  const avail = String(offer.availability);
                  if (avail.includes("InStock")) {
                    metadata.availability = "InStock";
                  } else if (avail.includes("OutOfStock")) {
                    metadata.availability = "OutOfStock";
                  } else if (avail.includes("PreOrder")) {
                    metadata.availability = "PreOrder";
                  } else {
                    metadata.availability = avail.split("/").pop(); // e.g. "Discontinued"
                  }
                }
              };

              if (Array.isArray(node.offers)) {
                for (const offer of node.offers) {
                  parseOffer(offer);
                  if (metadata.price !== null) break;
                }
              } else {
                parseOffer(node.offers);
              }
            }
            return true;
          }

          if (node["@graph"] && Array.isArray(node["@graph"])) {
            for (const subNode of node["@graph"]) {
              if (parseProductNode(subNode)) return true;
            }
          }

          return false;
        };

        if (Array.isArray(data)) {
          for (const item of data) {
            if (parseProductNode(item)) return false;
          }
        } else {
          parseProductNode(data);
        }
      } catch (err) {
        // ignore JSON-LD errors
      }
    });
  } catch (e) {
    // ignore
  }

  // 2. OpenGraph fallback
  if (!metadata.imageUrl) {
    metadata.imageUrl = $('meta[property="og:image"]').attr("content") || "";
  }
  if (metadata.price === null) {
    const ogPrice = $('meta[property="product:price:amount"]').attr("content") ||
                    $('meta[property="og:price:amount"]').attr("content");
    if (ogPrice) {
      const num = parseFloat(ogPrice);
      if (!isNaN(num)) metadata.price = num;
    }
  }
  if (!metadata.currency) {
    metadata.currency = $('meta[property="product:price:currency"]').attr("content") ||
                        $('meta[property="og:price:currency"]').attr("content") || "";
  }
  if (!metadata.brand) {
    metadata.brand = $('meta[property="product:brand"]').attr("content") || "";
  }
  if (!metadata.sku) {
    metadata.sku = $('meta[property="product:retailer_item_id"]').attr("content") || "";
  }
  if (!metadata.availability) {
    const ogAvail = $('meta[property="product:availability"]').attr("content") || "";
    if (ogAvail) {
      if (ogAvail.includes("in stock")) metadata.availability = "InStock";
      else if (ogAvail.includes("out of stock")) metadata.availability = "OutOfStock";
      else metadata.availability = ogAvail;
    }
  }

  // 3. Heuristic body search for price if still null
  if (metadata.price === null && (url.toLowerCase().includes("/product") || url.toLowerCase().includes("/shop"))) {
    const text = $("body").text();
    const priceMatch = text.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (priceMatch) {
      metadata.price = parseFloat(priceMatch[1]);
      if (!metadata.currency) metadata.currency = "USD";
    }
  }

  // Double check if page looks like product
  if (metadata.price !== null || metadata.sku || metadata.imageUrl.includes("/products/")) {
    metadata.isProduct = true;
  }

  return metadata;
}

/**
 * Refine HTML: Clean boilerplate, resolve links, extract structured metadata, and convert to Markdown.
 * 
 * @param {string} rawHtml - Scraped HTML string
 * @param {string} url - Source URL
 * @returns {{ markdown: string, title: string, metaDescription: string, productMetadata: Object }}
 */
function refineHtmlContent(rawHtml, url) {
  const $ = cheerio.load(rawHtml);

  const title = $("title").text().trim() || "";
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";

  // 1. Extract product details before we strip DOM
  const productMetadata = extractProductMetadata($, url);

  // 2. Clean and standardize DOM
  cleanHtmlDOM($);
  standardizeUrls($, url);

  // 3. Convert body HTML to Markdown
  const turndownService = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
  });

  const bodyHtml = $("body").html() || "";
  let markdown = turndownService.turndown(bodyHtml);

  // Clean double whitespace
  markdown = markdown
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    markdown,
    title,
    metaDescription,
    productMetadata,
  };
}

module.exports = {
  refineHtmlContent,
  extractProductMetadata,
};
