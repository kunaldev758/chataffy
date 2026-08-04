// const cheerio = require("cheerio");
// const urlModule = require("url");
// const {
//   stripInlineBufferImageContent,
//   FACET_SIDEBAR_SELECTORS,
// } = require("../htmlCleanup");

// /**
//  * Soft ceiling for pathological HTML only. Products extracted from the page
//  * are kept; adaptive batching (chunking) controls Qdrant density.
//  */
// const MAX_PRODUCTS = parseInt(process.env.LISTING_MAX_PRODUCTS || "500", 10);

// const GRID_SELECTORS = [
//   "#ProductGridContainer",
//   "#product-grid",
//   ".product-grid",
//   ".product-list",
//   ".collection-products",
//   ".collection__products",
//   "[data-product-grid]",
//   ".products-list",
//   ".product-items",
//   "ul.products",
//   ".products",
//   ".collection-grid",
//   ".CollectionInner",
//   "[data-collection-products]",
// ].join(", ");

// const CARD_SELECTORS = [
//   ".product-card",
//   ".product-item",
//   ".grid__item .card",
//   ".grid__item",
//   "[data-product-id]",
//   "[data-product-handle]",
//   "li.product",
//   ".card-wrapper",
//   ".product-block",
//   ".product",
//   ".woocommerce-LoopProduct-link",
//   "li.type-product",
// ].join(", ");

// function absolutize(href, pageUrl) {
//   if (!href) return null;
//   const raw = String(href).trim();
//   if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) {
//     return null;
//   }
//   try {
//     return urlModule.resolve(pageUrl || "", raw);
//   } catch {
//     return raw;
//   }
// }

// /**
//  * Normalize product URLs for join / dedupe (absolute, no hash/query noise).
//  */
// function normalizeProductUrl(href, pageUrl = "") {
//   const abs = absolutize(href, pageUrl);
//   if (!abs) return null;
//   try {
//     const u = new URL(abs);
//     u.hash = "";
//     // Drop tracking query; keep path/handle identity
//     u.search = "";
//     let path = u.pathname.replace(/\/+$/, "") || "/";
//     path = path.toLowerCase();
//     return `${u.origin.toLowerCase()}${path}`;
//   } catch {
//     return String(abs)
//       .split("?")[0]
//       .split("#")[0]
//       .replace(/\/+$/, "")
//       .toLowerCase();
//   }
// }

// function cleanText(s) {
//   return String(s || "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// /**
//  * Parse first usable price amount from text. Prefer sale when two amounts
//  * appear and sale keywords exist; otherwise prefer last amount on dual ranges.
//  */
// function parsePrice(text) {
//   const raw = String(text || "").replace(/,/g, "");
//   if (!raw) return null;
//   const nums = [...raw.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
//   const amounts = nums.filter((n) => !Number.isNaN(n) && n >= 0);
//   if (!amounts.length) return null;

//   const lower = raw.toLowerCase();
//   if (amounts.length >= 2) {
//     if (
//       /sale|now|from|only|deal|%\s*off/.test(lower) ||
//       /was|compare|regular|original|msrp|rrp/.test(lower)
//     ) {
//       // Prefer the last amount as "current" when compare/sale patterns appear
//       return amounts[amounts.length - 1];
//     }
//   }
//   return amounts[0];
// }

// function detectCurrency(text) {
//   const s = String(text || "");
//   if (/\$|USD|US\s*\$/i.test(s)) return "USD";
//   if (/€|EUR/i.test(s)) return "EUR";
//   if (/£|GBP/i.test(s)) return "GBP";
//   if (/₹|INR|Rs\.?/i.test(s)) return "INR";
//   if (/A\$|AUD/i.test(s)) return "AUD";
//   if (/C\$|CAD/i.test(s)) return "CAD";
//   if (/¥|JPY|CNY/i.test(s)) return "JPY";
//   const iso = s.match(/\b([A-Z]{3})\b/);
//   if (iso) return iso[1];
//   return null;
// }

// function pickOffer(node) {
//   if (!node || typeof node !== "object") return null;
//   const offers = Array.isArray(node.offers)
//     ? node.offers
//     : node.offers
//       ? [node.offers]
//       : [];
//   if (!offers.length) {
//     return String(node["@type"] || "")
//       .toLowerCase()
//       .includes("offer")
//       ? node
//       : null;
//   }
//   // Prefer offer with a price
//   for (const o of offers) {
//     if (o && typeof o === "object" && (o.price != null || o.lowPrice != null)) {
//       return o;
//     }
//   }
//   return typeof offers[0] === "object" ? offers[0] : { price: offers[0] };
// }

// function offerPriceFields(offer) {
//   if (!offer || typeof offer !== "object") {
//     return { price: null, compare_at: null, currency: null };
//   }
//   let price =
//     offer.price != null
//       ? Number(offer.price)
//       : offer.lowPrice != null
//         ? Number(offer.lowPrice)
//         : null;
//   if (Number.isNaN(price)) price = null;

//   let compare_at =
//     offer.highPrice != null
//       ? Number(offer.highPrice)
//       : offer.compareAtPrice != null
//         ? Number(offer.compareAtPrice)
//         : null;
//   if (Number.isNaN(compare_at)) compare_at = null;
//   if (compare_at != null && price != null && compare_at <= price) {
//     compare_at = null;
//   }

//   const currency =
//     offer.priceCurrency || offer.priceCurrencyCode || offer.currency || null;

//   return {
//     price,
//     compare_at,
//     currency: currency ? String(currency).toUpperCase() : null,
//   };
// }

// /**
//  * Map of normalized product URL → product row from JSON-LD.
//  * Used only to enrich DOM-visible products (never invents ghost rows).
//  */
// function indexListingJsonLdByUrl(jsonLdBlocks = [], pageUrl = "") {
//   const byUrl = new Map();

//   const push = (item) => {
//     if (!item || typeof item !== "object") return;
//     const name = cleanText(item.name || item.title || "");
//     const url = absolutize(
//       typeof item.url === "string"
//         ? item.url
//         : item["@id"] || item.offerUrl || null,
//       pageUrl,
//     );
//     const offer = pickOffer(item);
//     const { price, compare_at, currency } = offerPriceFields(offer);
//     const key = normalizeProductUrl(url, pageUrl);
//     if (!key && !name) return;

//     const row = {
//       name: name || null,
//       url: url || null,
//       price: price != null && !Number.isNaN(price) ? price : null,
//       compare_at: compare_at != null && !Number.isNaN(compare_at) ? compare_at : null,
//       currency,
//       price_text: null,
//       sku: item.sku || offer?.sku || null,
//       source: "json_ld",
//     };

//     if (key) {
//       const prev = byUrl.get(key);
//       if (!prev) {
//         byUrl.set(key, row);
//       } else {
//         byUrl.set(key, mergeProductRows(prev, row));
//       }
//     }
//   };

//   const walk = (node) => {
//     if (!node || typeof node !== "object") return;
//     if (Array.isArray(node)) {
//       for (const n of node) walk(n);
//       return;
//     }
//     const types = []
//       .concat(node["@type"] || [])
//       .map((t) =>
//         String(t || "")
//           .toLowerCase()
//           .replace(/^https?:\/\/schema\.org\//, ""),
//       );

//     if (types.includes("itemlist") || types.includes("offercatalog")) {
//       const els = [].concat(node.itemListElement || node.item || []);
//       for (const el of els) push(el?.item || el);
//     }
//     if (types.includes("productgroup")) {
//       for (const v of [].concat(node.hasVariant || [])) push(v);
//     }
//     if (types.includes("product") && (node.url || node.name)) {
//       push(node);
//     }
//     for (const [k, v] of Object.entries(node)) {
//       if (k === "@context") continue;
//       if (v && typeof v === "object") walk(v);
//     }
//   };

//   for (const block of [].concat(jsonLdBlocks || [])) walk(block);
//   return byUrl;
// }

// /**
//  * Collect product entities from ItemList / ProductGroup / OfferCatalog JSON-LD.
//  * (Exported for tests/debug — listing indexing uses DOM-first + this as enrich.)
//  */
// function extractListingFromJsonLd(jsonLdBlocks = [], pageUrl = "") {
//   const byUrl = indexListingJsonLdByUrl(jsonLdBlocks, pageUrl);
//   return [...byUrl.values()].slice(0, MAX_PRODUCTS);
// }

// function extractPriceFromCard($el) {
//   const contentPrice =
//     $el.find("[itemprop='price'][content]").attr("content") ||
//     $el.find("[data-price]").attr("data-price") ||
//     $el.find("[data-product-price]").attr("data-product-price") ||
//     $el.find("[data-price-amount]").attr("data-price-amount") ||
//     null;

//   const saleText = cleanText(
//     $el
//       .find(
//         ".price-item--sale, .sale-price, .price--sale, .special-price, [class*='price--on-sale'] .price-item, [data-sale-price]",
//       )
//       .first()
//       .text() || "",
//   );
//   const regularText = cleanText(
//     $el
//       .find(
//         ".price-item--regular, .price__regular, .regular-price, .compare-at-price, del .money, s .money, [class*='compare']",
//       )
//       .first()
//       .text() || "",
//   );
//   const blob = cleanText(
//     $el
//       .find(
//         "[itemprop='price'], .price, .price-item, .product-price, .money, .amount, .woocommerce-Price-amount",
//       )
//       .first()
//       .text() || "",
//   );

//   const priceText = saleText || contentPrice || regularText || blob;
//   const price =
//     parsePrice(contentPrice || "") != null
//       ? parsePrice(contentPrice)
//       : parsePrice(saleText || blob || regularText);
//   const compare_at =
//     saleText && regularText
//       ? parsePrice(regularText)
//       : parsePrice(regularText) != null &&
//           price != null &&
//           parsePrice(regularText) > price
//         ? parsePrice(regularText)
//         : null;
//   const currency = detectCurrency(
//     priceText || blob || regularText || contentPrice || "",
//   );

//   return {
//     price: price != null && !Number.isNaN(price) ? price : null,
//     compare_at:
//       compare_at != null && !Number.isNaN(compare_at) ? compare_at : null,
//     currency,
//     price_text: priceText || blob || null,
//   };
// }

// function extractCard($, el, pageUrl) {
//   const $el = $(el);
//   let href = null;
//   $el.find("a[href]").each((_, a) => {
//     if (href) return;
//     const h = ($(a).attr("href") || "").trim();
//     if (/\/products?\//i.test(h) || /\/p\//i.test(h) || /\/item\//i.test(h)) {
//       href = h;
//     }
//   });
//   if (!href) {
//     href = $el.find("a[href]").first().attr("href") || null;
//   }
//   const url = absolutize(href, pageUrl);

//   const name = cleanText(
//     $el
//       .find(
//         ".card__heading, .product-card__title, .product-title, .product-item__title, h2, h3, .card__title, [itemprop='name'], .woocommerce-loop-product__title",
//       )
//       .first()
//       .text() ||
//       $el.find("a[href*='/products/'], a[href*='/product/']").first().text() ||
//       $el.find("img[alt]").first().attr("alt") ||
//       "",
//   );

//   if (!name && !url) return null;
//   if (name && /^(clear|apply|filter|sort|collections?)$/i.test(name)) {
//     return null;
//   }

//   const pricing = extractPriceFromCard($el);
//   const row = {
//     name: name || null,
//     url: url || null,
//     source: "dom",
//     ...pricing,
//   };
//   if (row.price == null) delete row.price;
//   if (row.compare_at == null) delete row.compare_at;
//   if (!row.currency) delete row.currency;
//   if (!row.price_text) delete row.price_text;
//   return row;
// }

// function productKey(row, pageUrl = "") {
//   const urlKey = normalizeProductUrl(row?.url, pageUrl);
//   if (urlKey) return `u:${urlKey}`;
//   const name = cleanText(row?.name || "").toLowerCase();
//   if (name) {
//     const priceBit =
//       row?.price != null ? String(row.price) : row?.price_text || "";
//     return `n:${name}|${priceBit}`;
//   }
//   return null;
// }

// /**
//  * DOM: product grid / cards on collection & catalog pages.
//  * Scans all grids. Does not drop products short of MAX_PRODUCTS safety rail.
//  */
// function extractListingFromDom(html, pageUrl = "") {
//   if (!html) return [];
//   const $ = cheerio.load(html);

//   if (FACET_SIDEBAR_SELECTORS) {
//     $(FACET_SIDEBAR_SELECTORS).remove();
//   }
//   $("header, footer, nav, script, style, noscript").remove();

//   const products = [];
//   const seen = new Set();

//   const push = (row) => {
//     if (!row) return;
//     const key = productKey(row, pageUrl);
//     if (!key || seen.has(key)) return;
//     seen.add(key);
//     products.push(row);
//   };

//   const grids = $(GRID_SELECTORS).toArray();
//   let cards = [];
//   if (grids.length) {
//     for (const grid of grids) {
//       cards.push(...$(grid).find(CARD_SELECTORS).toArray());
//     }
//   } else {
//     cards = $(CARD_SELECTORS).toArray();
//   }

//   cards = cards.filter((el) => $(el).parents(CARD_SELECTORS).length === 0);

//   if (cards.length === 0) {
//     const $main = $("main, [role='main'], #MainContent, .main-content").first();
//     const root = $main.length ? $main : $.root();
//     root
//       .find(
//         "a[href*='/products/'], a[href*='/product/'], a[href*='/p/'], a[href*='/item/']",
//       )
//       .each((_, a) => {
//         const url = absolutize($(a).attr("href"), pageUrl);
//         const name = cleanText(
//           $(a).text() || $(a).find("img").attr("alt") || "",
//         );
//         if (!url) return;
//         const $card = $(a).closest(
//           "li, article, .grid__item, .card, .product, div",
//         );
//         const pricing = extractPriceFromCard($card);
//         const row = {
//           name: name || null,
//           url,
//           source: "dom",
//           ...pricing,
//         };
//         if (row.price == null) delete row.price;
//         if (row.compare_at == null) delete row.compare_at;
//         if (!row.currency) delete row.currency;
//         if (!row.price_text) delete row.price_text;
//         push(row);
//       });
//   } else {
//     for (const el of cards) {
//       push(extractCard($, el, pageUrl));
//       if (products.length >= MAX_PRODUCTS) break;
//     }
//   }

//   return products.slice(0, MAX_PRODUCTS);
// }

// function mergeProductRows(base, extra) {
//   if (!base) return { ...extra };
//   if (!extra) return { ...base };
//   const out = { ...base };
//   out.name = base.name || extra.name || null;
//   out.url = base.url || extra.url || null;
//   out.price = base.price != null ? base.price : extra.price;
//   out.compare_at =
//     base.compare_at != null ? base.compare_at : extra.compare_at;
//   out.currency = base.currency || extra.currency || null;
//   out.price_text = base.price_text || extra.price_text || null;
//   out.sku = base.sku || extra.sku || null;
//   if (base.source === "dom" && extra.source === "json_ld") {
//     out.source = "dom+json_ld";
//   } else if (extra.source === "dom" && base.source === "json_ld") {
//     out.source = "dom+json_ld";
//   } else {
//     out.source = base.source || extra.source || null;
//   }
//   for (const k of ["price", "compare_at", "currency", "price_text", "sku"]) {
//     if (out[k] == null || out[k] === "") delete out[k];
//   }
//   return out;
// }

// /**
//  * DOM-first inventory; enrich matching rows only when JSON-LD URL matches.
//  * Does not add LD-only products that aren't visible on the page.
//  * If DOM is empty, fall back to JSON-LD list so sparse pages still index.
//  */
// function enrichProductsFromJsonLd(domProducts, jsonLdBlocks, pageUrl) {
//   const ldByUrl = indexListingJsonLdByUrl(jsonLdBlocks, pageUrl);
//   if (!domProducts.length) {
//     return [...ldByUrl.values()].slice(0, MAX_PRODUCTS);
//   }

//   return domProducts.map((dom) => {
//     const key = normalizeProductUrl(dom.url, pageUrl);
//     if (!key || !ldByUrl.has(key)) return { ...dom };
//     return mergeProductRows(dom, ldByUrl.get(key));
//   });
// }

// function formatPriceLine(p) {
//   if (p.price != null) {
//     const cur = p.currency ? ` ${p.currency}` : "";
//     return `${p.price}${cur}`;
//   }
//   if (p.price_text) return p.price_text;
//   return null;
// }

// /**
//  * One self-contained markdown block for a product (heading + bullets).
//  * Used by extract markdown and by Qdrant listing chunker.
//  */
// function productToMarkdownBlock(p) {
//   const name = cleanText(p.name) || "Product";
//   const lines = [`### ${name}`];
//   const priceLine = formatPriceLine(p);
//   if (priceLine) lines.push(`- Price: ${priceLine}`);
//   if (p.compare_at != null) {
//     const cur = p.currency ? ` ${p.currency}` : "";
//     lines.push(`- Was: ${p.compare_at}${cur}`);
//   }
//   if (p.price_text && p.price != null && p.price_text !== String(p.price)) {
//     lines.push(`- Price text: ${p.price_text}`);
//   }
//   if (p.sku) lines.push(`- SKU: ${p.sku}`);
//   if (p.url) lines.push(`- URL: ${p.url}`);
//   return lines.join("\n");
// }

// function buildListingHeader({ title, pageUrl, products, description }) {
//   const lines = [];
//   if (title) lines.push(`# ${title}`);
//   if (pageUrl) lines.push(`\nURL: ${pageUrl}`);
//   lines.push(`\nProducts on this page: ${products.length}`);
//   if (description) {
//     lines.push("\n## About");
//     lines.push(description.trim());
//   }
//   return lines.join("\n").trim();
// }

// function buildListingIndex(products) {
//   const lines = ["## Index"];
//   if (!products.length) {
//     lines.push("_No products extracted._");
//     return lines.join("\n");
//   }
//   for (const p of products) {
//     const name = cleanText(p.name) || "Product";
//     const priceLine = formatPriceLine(p);
//     lines.push(priceLine ? `- ${name} — ${priceLine}` : `- ${name}`);
//   }
//   return lines.join("\n");
// }

// function listingToMarkdown({ title, pageUrl, products, description }) {
//   const parts = [
//     buildListingHeader({ title, pageUrl, products, description }),
//     buildListingIndex(products),
//   ];

//   parts.push("\n## Products");
//   if (!products.length) {
//     parts.push("_No products extracted._");
//   } else {
//     for (const p of products) {
//       parts.push("\n" + productToMarkdownBlock(p));
//     }
//   }

//   return stripInlineBufferImageContent(
//     parts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
//   );
// }

// /**
//  * Adaptive batch size: 1 product per child for normal listings;
//  * multi-product batches only for large N. Never drops products.
//  *
//  * @param {number} productCount
//  * @returns {number} products per child chunk
//  */
// function resolveListingBatchSize(productCount) {
//   const n = Number(productCount) || 0;
//   const oneThrough = parseInt(process.env.LISTING_ONE_PER_CHILD_MAX || "40", 10);
//   const mid = parseInt(process.env.LISTING_BATCH_MID || "120", 10);
//   const high = parseInt(process.env.LISTING_BATCH_HIGH || "300", 10);

//   if (n <= oneThrough) return 1;
//   if (n <= mid) return parseInt(process.env.LISTING_BATCH_SIZE_MID || "4", 10);
//   if (n <= high) return parseInt(process.env.LISTING_BATCH_SIZE_HIGH || "8", 10);
//   return parseInt(process.env.LISTING_BATCH_SIZE_XLARGE || "12", 10);
// }

// function resolveListingTitle(title, html, pageUrl) {
//   const t = cleanText(title || "");
//   if (t && t !== pageUrl && !/^https?:\/\//i.test(t)) return t;

//   if (html) {
//     const $ = cheerio.load(html);
//     const h1 = cleanText($("h1").first().text());
//     if (h1 && h1.length < 120) return h1;
//     const og = cleanText($('meta[property="og:title"]').attr("content"));
//     if (og && !/^https?:\/\//i.test(og)) return og;
//   }
//   return "Product listing";
// }

// /**
//  * Slim product row for Qdrant payload (drop nulls).
//  */
// function slimProduct(p) {
//   if (!p || typeof p !== "object") return null;
//   const out = {};
//   if (p.name) out.name = p.name;
//   if (p.url) out.url = p.url;
//   if (p.price != null) out.price = p.price;
//   if (p.compare_at != null) out.compare_at = p.compare_at;
//   if (p.currency) out.currency = p.currency;
//   if (p.price_text) out.price_text = p.price_text;
//   if (p.sku) out.sku = p.sku;
//   return Object.keys(out).length ? out : null;
// }

// /**
//  * PLP / collection listing extraction.
//  * DOM-first visible products → JSON-LD enrich by URL → structured markdown.
//  *
//  * @returns {{ content, entity_name, attributes, products, extraction_source, extraction_confidence }}
//  */
// function extractListingContent({
//   url,
//   html,
//   jsonLdBlocks = [],
//   title = null,
//   metaDescription = null,
// } = {}) {
//   const fromDom = extractListingFromDom(html, url);
//   const ldIndex = indexListingJsonLdByUrl(jsonLdBlocks, url);
//   const products = enrichProductsFromJsonLd(
//     fromDom,
//     jsonLdBlocks,
//     url,
//   ).slice(0, MAX_PRODUCTS);

//   const entity_name = resolveListingTitle(title, html, url);
//   const slimProducts = products.map(slimProduct).filter(Boolean);

//   const attributes = {
//     product_urls: products.map((p) => p.url).filter(Boolean),
//     product_count: products.length,
//     products: slimProducts,
//     listing_batch_size: resolveListingBatchSize(products.length),
//   };

//   const content = listingToMarkdown({
//     title: entity_name,
//     pageUrl: url,
//     products,
//     description: metaDescription || "",
//   });

//   const enrichedCount = products.filter(
//     (p) => p.source === "dom+json_ld",
//   ).length;
//   let source = "listing_empty";
//   if (fromDom.length && ldIndex.size) {
//     source =
//       enrichedCount > 0 ? "dom+json_ld_listing" : "dom_listing+json_ld_index";
//   } else if (fromDom.length) {
//     source = "dom_listing";
//   } else if (ldIndex.size) {
//     source = "json_ld_listing_fallback";
//   }

//   return {
//     content,
//     entity_name,
//     attributes,
//     products,
//     extraction_source: source,
//     extraction_confidence:
//       products.length >= 3 ? 0.85 : products.length ? 0.65 : 0.3,
//   };
// }

// module.exports = {
//   extractListingContent,
//   extractListingFromJsonLd,
//   extractListingFromDom,
//   enrichProductsFromJsonLd,
//   listingToMarkdown,
//   productToMarkdownBlock,
//   buildListingHeader,
//   buildListingIndex,
//   resolveListingBatchSize,
//   slimProduct,
//   normalizeProductUrl,
//   GRID_SELECTORS,
//   CARD_SELECTORS,
//   MAX_PRODUCTS,
// };


const cheerio = require("cheerio");
const urlModule = require("url");

const {
  stripInlineBufferImageContent,
  FACET_SIDEBAR_SELECTORS,
} = require("../htmlCleanup");

/**
 * Safety ceiling only.
 *
 * This does not control Qdrant chunk density. Adaptive listing batching
 * should be handled by the listing-aware chunker using listing_batch_size.
 */
const MAX_PRODUCTS = Math.max(
  1,
  parseInt(process.env.LISTING_MAX_PRODUCTS || "500", 10) || 500,
);

/**
 * Candidate containers that may hold the primary product listing.
 *
 * We score these containers and select the one with the largest number of
 * unique, valid product links instead of blindly combining every grid.
 */
const GRID_SELECTORS = [
  "#ProductGridContainer",
  "#product-grid",
  "#products-grid",
  ".product-grid",
  ".products-grid",
  ".product-list",
  ".products-list",
  ".collection-products",
  ".collection__products",
  ".collection-grid",
  ".collection__grid",
  ".category-products",
  ".product-items",
  "ul.products",
  ".products",
  ".CollectionInner",
  "[data-product-grid]",
  "[data-products-grid]",
  "[data-collection-products]",
  "[role='list'][data-products]",
].join(", ");

/**
 * These selectors are used only as the nearest card context for an already
 * validated product link.
 *
 * Avoid broad standalone selectors such as:
 * - .product
 * - .grid__item as a global card selector
 * - [data-product-id]
 * - [data-product-handle]
 */
const CARD_CONTEXT_SELECTORS = [
  "[data-product-card]",
  "[data-product-item]",
  ".product-card-wrapper",
  ".product-card",
  ".product-item-info",
  ".product-item",
  ".card-wrapper",
  ".product-block",
  "li.product",
  "article.product",
  "li.type-product",
  ".grid__item",
].join(", ");

const EXCLUDED_SELECTORS = [
  "header",
  "footer",
  "nav",
  "script",
  "style",
  "noscript",
  "template",
  "iframe",

  "[hidden]",
  "[aria-hidden='true']",
  ".hidden",

  ".product-recommendations",
  "product-recommendations",
  "[data-product-recommendations]",
  ".recommendations",
  ".related-products",
  ".recently-viewed",
  ".recently-viewed-products",
  ".upsell-products",
  ".cross-sell",

  ".quick-view",
  ".quickview",
  ".modal",
  ".drawer",
  ".predictive-search",
  ".search-suggestions",
  ".wishlist-drawer",
  ".compare-products",
].join(", ");

const NAME_SELECTORS = [
  "[itemprop='name']",
  "[data-product-title]",
  ".product-card__title",
  ".product-item__title",
  ".product-title",
  ".product-name",
  ".card__heading",
  ".card__title",
  ".woocommerce-loop-product__title",
].join(", ");

const CURRENT_PRICE_SELECTORS = [
  "[itemprop='price'][content]",
  "meta[itemprop='price'][content]",
  "[data-product-price]",
  "[data-price-amount]",
  "[data-sale-price]",
  ".price-item--sale",
  ".price__sale .price-item",
  ".sale-price",
  ".special-price .price",
  ".current-price",
  ".price--on-sale .price-item",
].join(", ");

const REGULAR_PRICE_SELECTORS = [
  "[data-compare-price]",
  ".compare-at-price",
  ".price-item--regular",
  ".price__regular .price-item",
  ".regular-price",
  ".old-price",
  ".was-price",
  "s .money",
  "del .money",
  "del .woocommerce-Price-amount",
].join(", ");

const GENERIC_PRICE_SELECTORS = [
  "[itemprop='price']",
  ".product-price",
  ".price",
  ".money",
  ".amount",
  ".woocommerce-Price-amount",
].join(", ");

const IMAGE_SELECTORS = [
  "img[data-src]",
  "img[data-original]",
  "img[data-lazy-src]",
  "img[data-srcset]",
  "img[srcset]",
  "img[src]",
].join(", ");

const PRODUCT_URL_PATTERNS = [
  /\/products?\//i,
  /\/product\//i,
  /\/p\//i,
  /\/item\//i,
  /\/shop\/[^/]+\/?$/i,
  /\/[^/]+-p-\d+\/?$/i,
];

const INVALID_PRODUCT_PATH_PATTERN =
  /\/(account|login|register|cart|checkout|wishlist|search|blogs?|pages?|collections?|categories?|catalog|policies)(\/|$)/i;

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeEmptyFields(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => {
      if (value === null || value === undefined || value === "") {
        return false;
      }

      if (Array.isArray(value) && value.length === 0) {
        return false;
      }

      return true;
    }),
  );
}

function firstAttribute($node, attributes = []) {
  if (!$node || !$node.length) return null;

  for (const attribute of attributes) {
    const value = cleanText($node.attr(attribute));

    if (value) {
      return value;
    }
  }

  return null;
}

function absolutize(href, pageUrl = "") {
  if (!href) return null;

  const raw = cleanText(href);

  if (
    !raw ||
    raw.startsWith("#") ||
    /^javascript:/i.test(raw) ||
    /^mailto:/i.test(raw) ||
    /^tel:/i.test(raw) ||
    /^data:/i.test(raw)
  ) {
    return null;
  }

  try {
    return urlModule.resolve(pageUrl || "", raw);
  } catch {
    return raw;
  }
}

/**
 * Normalize product URLs for deduplication and JSON-LD joins.
 *
 * Tracking parameters are removed. The Shopify variant parameter is retained
 * because it may identify the displayed variant.
 */
function normalizeProductUrl(href, pageUrl = "") {
  const absolute = absolutize(href, pageUrl);

  if (!absolute) return null;

  try {
    const parsed = new URL(absolute);

    parsed.hash = "";

    const allowedParams = new Set(["variant"]);

    for (const key of [...parsed.searchParams.keys()]) {
      if (!allowedParams.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(absolute)
      .split("#")[0]
      .replace(
        /([?&])(utm_[^=]+|gclid|fbclid|ref|source|sort_by)=[^&]*/gi,
        "$1",
      )
      .replace(/[?&]+$/, "")
      .replace(/\/$/, "");
  }
}

function isSameHost(candidateUrl, pageUrl) {
  if (!candidateUrl || !pageUrl) return true;

  try {
    const candidate = new URL(candidateUrl, pageUrl);
    const page = new URL(pageUrl);

    const candidateHost = candidate.hostname.replace(/^www\./i, "");
    const pageHost = page.hostname.replace(/^www\./i, "");

    return candidateHost === pageHost;
  } catch {
    return true;
  }
}

/**
 * Strictly validate that a URL represents a product page.
 *
 * This prevents /account, /cart, collection, wishlist and quick-view links
 * from becoming fake products.
 */
function isLikelyProductUrl(candidateUrl, pageUrl = "") {
  const normalized = normalizeProductUrl(candidateUrl, pageUrl);

  if (!normalized) return false;
  if (!isSameHost(normalized, pageUrl)) return false;

  try {
    const parsed = new URL(normalized, pageUrl);
    const pathname = parsed.pathname.toLowerCase();

    if (
      INVALID_PRODUCT_PATH_PATTERN.test(pathname) &&
      !/\/products?\//i.test(pathname)
    ) {
      return false;
    }

    return PRODUCT_URL_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

function parseNumericPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let raw = cleanText(value);

  if (!raw) return null;

  raw = raw.replace(/[^\d.,-]/g, "");

  if (!raw) return null;

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");

  /**
   * European formatting:
   * 1.299,99 => 1299.99
   */
  if (lastComma > lastDot && lastComma !== -1) {
    const decimalLength = raw.length - lastComma - 1;

    if (decimalLength === 2) {
      raw = raw.replace(/\./g, "").replace(",", ".");
    } else {
      raw = raw.replace(/,/g, "");
    }
  } else {
    /**
     * US/Indian formatting:
     * 1,299.99 => 1299.99
     * 1,299 => 1299
     */
    raw = raw.replace(/,/g, "");
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a single price from either a machine-readable value or visible text.
 *
 * Machine-readable values may be plain numbers. Visible mixed text requires a
 * currency symbol/code so percentages and review counts are not treated as
 * prices.
 */
function parsePrice(value) {
  const text = cleanText(value);

  if (!text) return null;

  if (/^\s*-?\d[\d.,]*\s*$/.test(text)) {
    return parseNumericPrice(text);
  }

  const patterns = [
    /(?:USD|CAD|AUD|NZD|EUR|GBP|INR|JPY|CNY|AED|SAR)\s*[$€£₹¥]?\s*(-?\d[\d.,]*)/i,
    /(?:US\$|C\$|A\$)\s*(-?\d[\d.,]*)/i,
    /[$€£₹¥]\s*(-?\d[\d.,]*)/,
    /(?:Rs\.?|INR)\s*(-?\d[\d.,]*)/i,
    /(-?\d[\d.,]*)\s*(?:USD|CAD|AUD|NZD|EUR|GBP|INR|JPY|CNY|AED|SAR)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) continue;

    const price = parseNumericPrice(match[1]);

    if (price !== null) {
      return price;
    }
  }

  return null;
}

function detectCurrency(value) {
  const text = cleanText(value);

  if (!text) return null;

  /**
   * Specific dollar currencies must be checked before the generic $ check.
   */
  if (/A\$|AUD/i.test(text)) return "AUD";
  if (/C\$|CAD/i.test(text)) return "CAD";
  if (/NZ\$|NZD/i.test(text)) return "NZD";
  if (/US\$|USD/i.test(text)) return "USD";

  if (/₹|INR|Rs\.?/i.test(text)) return "INR";
  if (/€|EUR/i.test(text)) return "EUR";
  if (/£|GBP/i.test(text)) return "GBP";
  if (/CN¥|CNY/i.test(text)) return "CNY";
  if (/¥|JPY/i.test(text)) return "JPY";
  if (/AED/i.test(text)) return "AED";
  if (/SAR/i.test(text)) return "SAR";

  if (/\$/i.test(text)) return "USD";

  return null;
}

function normalizeAvailability(value) {
  const text = cleanText(value).toLowerCase();

  if (!text) return null;

  const normalized = text.replace(/^https?:\/\/schema\.org\//, "");

  if (/outofstock|out of stock|sold out|unavailable/.test(normalized)) {
    return "out_of_stock";
  }

  if (/instock|in stock|available/.test(normalized)) {
    return "in_stock";
  }

  if (/preorder|pre-order/.test(normalized)) {
    return "preorder";
  }

  if (/backorder|back-order/.test(normalized)) {
    return "backorder";
  }

  if (/discontinued/.test(normalized)) {
    return "discontinued";
  }

  return normalized.replace(/\s+/g, "_");
}

function cleanProductName(value) {
  let name = cleanText(value);

  if (!name) return "";

  /**
   * Remove price text accidentally included inside product-link text.
   *
   * Example:
   * "After Hours Lip Liner (Dark Brown) Rs. 600.00"
   */
  name = name
    .replace(
      /\s+(?:Rs\.?|INR|USD|CAD|AUD|EUR|GBP)?\s*[$€£₹¥]?\s*\d[\d,.]*\s*$/i,
      "",
    )
    .replace(/\s+(?:sale|sold out|notify me when available)\s*$/i, "")
    .trim();

  return name;
}

function getSrcsetImage(srcset) {
  const value = cleanText(srcset);

  if (!value) return null;

  const candidates = value
    .split(",")
    .map((entry) => {
      const parts = cleanText(entry).split(/\s+/);
      const imageUrl = parts[0];
      const widthText = parts[1] || "";

      const width = widthText.endsWith("w")
        ? Number(widthText.replace("w", ""))
        : 0;

      return {
        url: imageUrl,
        width: Number.isFinite(width) ? width : 0,
      };
    })
    .filter((entry) => entry.url);

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.width - a.width);

  return candidates[0].url;
}

function extractImageFromCard($card, pageUrl) {
  const $image = $card.find(IMAGE_SELECTORS).first();

  if (!$image.length) {
    return {
      image: null,
      image_alt: null,
    };
  }

  let imageUrl = firstAttribute($image, [
    "data-src",
    "data-original",
    "data-lazy-src",
    "src",
  ]);

  if (!imageUrl) {
    imageUrl = getSrcsetImage(
      firstAttribute($image, ["data-srcset", "srcset"]),
    );
  }

  return {
    image: absolutize(imageUrl, pageUrl),
    image_alt: cleanText($image.attr("alt")) || null,
  };
}

function readPriceCandidate($, node) {
  const $node = $(node);

  const attributeValue = firstAttribute($node, [
    "content",
    "data-product-price",
    "data-price",
    "data-price-amount",
    "data-sale-price",
    "data-compare-price",
    "value",
  ]);

  const textValue = cleanText($node.text());

  return {
    raw: attributeValue || textValue || null,
    text: textValue || null,
  };
}

function extractFirstPrice($, $card, selector) {
  const candidates = $card.find(selector).toArray();

  for (const candidate of candidates) {
    const { raw, text } = readPriceCandidate($, candidate);
    const price = parsePrice(raw);

    if (price === null) continue;

    return {
      price,
      raw,
      text,
      currency:
        detectCurrency(raw) ||
        detectCurrency(text),
    };
  }

  return null;
}

/**
 * Extract current and compare-at prices from the same product card.
 */
function extractPriceFromCard($, $card) {
  const machinePrice =
    firstAttribute(
      $card.find("[itemprop='price'][content]").first(),
      ["content"],
    ) ||
    firstAttribute(
      $card.find("[data-product-price]").first(),
      ["data-product-price"],
    ) ||
    firstAttribute(
      $card.find("[data-price-amount]").first(),
      ["data-price-amount"],
    ) ||
    null;

  const salePrice = extractFirstPrice(
    $,
    $card,
    CURRENT_PRICE_SELECTORS,
  );

  const regularPrice = extractFirstPrice(
    $,
    $card,
    REGULAR_PRICE_SELECTORS,
  );

  const genericPrice = extractFirstPrice(
    $,
    $card,
    GENERIC_PRICE_SELECTORS,
  );

  const machineParsed = parsePrice(machinePrice);

  const currentPrice =
    machineParsed ??
    salePrice?.price ??
    genericPrice?.price ??
    regularPrice?.price ??
    null;

  let compareAtPrice = regularPrice?.price ?? null;

  if (
    compareAtPrice !== null &&
    currentPrice !== null &&
    compareAtPrice <= currentPrice
  ) {
    compareAtPrice = null;
  }

  const priceText =
    salePrice?.text ||
    salePrice?.raw ||
    genericPrice?.text ||
    genericPrice?.raw ||
    machinePrice ||
    regularPrice?.text ||
    regularPrice?.raw ||
    null;

  const currency =
    salePrice?.currency ||
    genericPrice?.currency ||
    regularPrice?.currency ||
    detectCurrency(machinePrice) ||
    detectCurrency(priceText);

  return removeEmptyFields({
    price: currentPrice,
    compare_at: compareAtPrice,
    currency,
    price_text: priceText,
  });
}

function extractAvailabilityFromCard($card) {
  const directValue = firstAttribute($card, [
    "data-availability",
    "data-stock-status",
  ]);

  if (directValue) {
    return normalizeAvailability(directValue);
  }

  const $availability = $card
    .find(
      [
        "[itemprop='availability']",
        ".availability",
        ".stock",
        ".product-stock",
        ".sold-out",
        ".soldout",
        "[data-stock-status]",
      ].join(", "),
    )
    .first();

  const raw =
    firstAttribute($availability, [
      "href",
      "content",
      "data-stock-status",
      "aria-label",
    ]) ||
    cleanText($availability.text());

  if (raw) {
    return normalizeAvailability(raw);
  }

  const cardText = cleanText($card.text());

  if (/sold out|notify me when available|unavailable/i.test(cardText)) {
    return "out_of_stock";
  }

  return null;
}

/**
 * Find all unique valid product links inside a container.
 */
function collectValidProductLinks($, $scope, pageUrl) {
  const links = [];
  const seen = new Set();

  $scope.find("a[href]").each((_, anchor) => {
    const $anchor = $(anchor);

    const url = normalizeProductUrl(
      $anchor.attr("href"),
      pageUrl,
    );

    if (!isLikelyProductUrl(url, pageUrl)) {
      return;
    }

    const key = url.toLowerCase();

    if (seen.has(key)) return;

    seen.add(key);

    links.push({
      url,
      $anchor,
    });
  });

  return links;
}

function scoreGrid($, grid, pageUrl) {
  const $grid = $(grid);

  if ($grid.closest(EXCLUDED_SELECTORS).length) {
    return -1;
  }

  const productLinks = collectValidProductLinks(
    $,
    $grid,
    pageUrl,
  );

  if (!productLinks.length) {
    return -1;
  }

  const textLength = cleanText($grid.text()).length;

  return (
    productLinks.length * 10 +
    Math.min(textLength / 1000, 5)
  );
}

/**
 * Select one primary listing grid.
 *
 * This prevents related products, recently viewed products and hidden mobile
 * duplicates from being merged into the collection inventory.
 */
function chooseBestListingScope($, pageUrl) {
  const grids = $(GRID_SELECTORS).toArray();

  let bestGrid = null;
  let bestScore = -1;

  for (const grid of grids) {
    const score = scoreGrid($, grid, pageUrl);

    if (score > bestScore) {
      bestGrid = grid;
      bestScore = score;
    }
  }

  if (bestGrid) {
    return $(bestGrid);
  }

  const $main = $(
    [
      "main",
      "[role='main']",
      "#MainContent",
      "#main-content",
      ".main-content",
      ".page-content",
    ].join(", "),
  ).first();

  return $main.length ? $main : $.root();
}

/**
 * Find the nearest safe product-card context for a validated product link.
 */
function findCardForProductLink($anchor, $scope) {
  const $card = $anchor.closest(CARD_CONTEXT_SELECTORS);

  if (!$card.length) {
    return null;
  }

  /**
   * Make sure the detected card is inside the selected listing scope.
   */
  if (
    $scope.get(0) !== $card.get(0) &&
    !$card.closest($scope).length
  ) {
    return null;
  }

  return $card;
}

function extractProductName($card, $anchor) {
  const selectorName = cleanProductName(
    $card.find(NAME_SELECTORS).first().text(),
  );

  if (selectorName) {
    return selectorName;
  }

  const linkName = cleanProductName(
    $anchor.attr("title") ||
    $anchor.attr("aria-label") ||
    $anchor.find("img[alt]").first().attr("alt") ||
    $anchor.text(),
  );

  if (linkName) {
    return linkName;
  }

  const imageAlt = cleanProductName(
    $card.find("img[alt]").first().attr("alt"),
  );

  return imageAlt || null;
}

/**
 * Extract one product using a validated product link and its nearest card.
 *
 * The URL comes from the specific anchor being processed, so the function does
 * not accidentally use the first anchor from another product or /account.
 */
function extractCardFromProductLink(
  $,
  $card,
  $anchor,
  productUrl,
  pageUrl,
) {
  if (!$card || !$card.length) return null;
  if (!isLikelyProductUrl(productUrl, pageUrl)) return null;

  const name = extractProductName(
    $card,
    $anchor,
  );

  if (
    !name ||
    /^(clear|apply|filter|sort|collections?|view all|shop all|quick view)$/i.test(
      name,
    )
  ) {
    return null;
  }

  const pricing = extractPriceFromCard(
    $,
    $card,
  );

  const imageData = extractImageFromCard(
    $card,
    pageUrl,
  );

  const sku =
    firstAttribute($card, [
      "data-sku",
      "data-product-sku",
    ]) ||
    firstAttribute(
      $card.find("[itemprop='sku']").first(),
      ["content", "value"],
    ) ||
    cleanText(
      $card.find("[itemprop='sku']").first().text(),
    ) ||
    null;

  const productId =
    firstAttribute($card, [
      "data-product-id",
      "data-id",
      "data-product",
    ]) || null;

  const handle =
    firstAttribute($card, [
      "data-product-handle",
      "data-handle",
    ]) || null;

  const vendor =
    cleanText(
      $card
        .find(
          [
            ".vendor",
            ".product-vendor",
            ".card__vendor",
            "[itemprop='brand']",
          ].join(", "),
        )
        .first()
        .text(),
    ) || null;

  const ratingNode = $card
    .find(
      "[data-rating], [itemprop='ratingValue']",
    )
    .first();

  const ratingRaw =
    firstAttribute(ratingNode, [
      "data-rating",
      "content",
      "value",
    ]) ||
    cleanText(ratingNode.text());

  const rating = parseNumericPrice(ratingRaw);

  const reviewNode = $card
    .find(
      "[data-review-count], [itemprop='reviewCount']",
    )
    .first();

  const reviewRaw =
    firstAttribute(reviewNode, [
      "data-review-count",
      "content",
      "value",
    ]) ||
    cleanText(reviewNode.text());

  const reviewCount = reviewRaw
    ? Number(
        String(reviewRaw).replace(/[^\d]/g, ""),
      )
    : null;

  return removeEmptyFields({
    name,
    url: normalizeProductUrl(
      productUrl,
      pageUrl,
    ),

    ...pricing,

    image: imageData.image,
    image_alt: imageData.image_alt,

    sku,
    product_id: productId,
    handle,
    vendor,

    availability:
      extractAvailabilityFromCard($card),

    rating:
      rating !== null &&
      Number.isFinite(rating)
        ? rating
        : null,

    review_count:
      Number.isFinite(reviewCount)
        ? reviewCount
        : null,

    source: "dom",
  });
}

function productKey(product, pageUrl = "") {
  const normalizedUrl = normalizeProductUrl(
    product?.url,
    pageUrl,
  );

  if (normalizedUrl) {
    return `url:${normalizedUrl.toLowerCase()}`;
  }

  const productId = cleanText(
    product?.product_id ||
    product?.sku,
  ).toLowerCase();

  if (productId) {
    return `id:${productId}`;
  }

  const name = cleanText(
    product?.name,
  ).toLowerCase();

  if (!name) return null;

  const priceValue =
    product?.price ??
    product?.price_text ??
    "";

  return `fallback:${name}|${priceValue}`;
}

/**
 * DOM listing extraction.
 *
 * Core strategy:
 * 1. Remove unrelated sections.
 * 2. Select the strongest listing grid.
 * 3. Collect every unique, valid product URL inside that grid.
 * 4. Resolve the nearest card separately for each product URL.
 * 5. Extract price/name only from that product's own card.
 */
function extractListingFromDom(
  html,
  pageUrl = "",
) {
  if (!html) return [];

  const $ = cheerio.load(html);

  if (FACET_SIDEBAR_SELECTORS) {
    $(FACET_SIDEBAR_SELECTORS).remove();
  }

  $(EXCLUDED_SELECTORS).remove();

  const $scope = chooseBestListingScope(
    $,
    pageUrl,
  );

  const productLinks = collectValidProductLinks(
    $,
    $scope,
    pageUrl,
  );

  const products = [];
  const seen = new Set();

  for (const {
    url,
    $anchor,
  } of productLinks) {
    const $card = findCardForProductLink(
      $anchor,
      $scope,
    );

    if (!$card || !$card.length) {
      continue;
    }

    const product = extractCardFromProductLink(
      $,
      $card,
      $anchor,
      url,
      pageUrl,
    );

    if (!product) continue;

    const key = productKey(
      product,
      pageUrl,
    );

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    products.push(product);

    if (products.length >= MAX_PRODUCTS) {
      break;
    }
  }

  return products;
}

function getJsonLdTypes(node) {
  return []
    .concat(node?.["@type"] || [])
    .map((type) =>
      cleanText(type)
        .toLowerCase()
        .replace(
          /^https?:\/\/schema\.org\//,
          "",
        ),
    );
}

function getJsonLdOffer(item) {
  const offers = item?.offers;

  if (Array.isArray(offers)) {
    return (
      offers.find(
        (offer) =>
          offer &&
          typeof offer === "object" &&
          (
            offer.price !== undefined ||
            offer.lowPrice !== undefined
          ),
      ) ||
      offers.find(
        (offer) =>
          offer &&
          typeof offer === "object",
      ) ||
      null
    );
  }

  if (
    offers &&
    typeof offers === "object"
  ) {
    return offers;
  }

  return null;
}

function getJsonLdImage(image, pageUrl) {
  if (!image) return null;

  if (typeof image === "string") {
    return absolutize(image, pageUrl);
  }

  if (Array.isArray(image)) {
    for (const entry of image) {
      const extracted = getJsonLdImage(
        entry,
        pageUrl,
      );

      if (extracted) return extracted;
    }

    return null;
  }

  if (typeof image === "object") {
    return absolutize(
      image.url ||
      image.contentUrl ||
      image["@id"],
      pageUrl,
    );
  }

  return null;
}

function extractJsonLdProductRow(
  item,
  pageUrl,
) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  const offer = getJsonLdOffer(item);

  const url = normalizeProductUrl(
    typeof item.url === "string"
      ? item.url
      : item["@id"] ||
        item.offerUrl ||
        offer?.url ||
        null,
    pageUrl,
  );

  if (
    !url ||
    !isLikelyProductUrl(url, pageUrl)
  ) {
    return null;
  }

  const price = parseNumericPrice(
    offer?.price ??
    offer?.lowPrice ??
    item.price,
  );

  let compareAt = parseNumericPrice(
    offer?.highPrice ??
    offer?.compareAtPrice,
  );

  if (
    compareAt !== null &&
    price !== null &&
    compareAt <= price
  ) {
    compareAt = null;
  }

  const brand =
    typeof item.brand === "string"
      ? item.brand
      : item.brand?.name ||
        item.manufacturer?.name ||
        null;

  const aggregateRating =
    item.aggregateRating &&
    typeof item.aggregateRating === "object"
      ? item.aggregateRating
      : null;

  return removeEmptyFields({
    name:
      cleanProductName(
        item.name || item.title,
      ) || null,

    url,

    description:
      cleanText(item.description) || null,

    price,
    compare_at: compareAt,

    currency:
      cleanText(
        offer?.priceCurrency ||
        item.priceCurrency,
      ).toUpperCase() || null,

    image: getJsonLdImage(
      item.image,
      pageUrl,
    ),

    sku:
      cleanText(
        item.sku || offer?.sku,
      ) || null,

    mpn:
      cleanText(item.mpn) || null,

    gtin:
      cleanText(
        item.gtin ||
        item.gtin8 ||
        item.gtin12 ||
        item.gtin13 ||
        item.gtin14,
      ) || null,

    product_id:
      cleanText(
        item.productID ||
        (
          typeof item.identifier === "string"
            ? item.identifier
            : item.identifier?.value
        ),
      ) || null,

    vendor:
      cleanText(brand) || null,

    availability:
      normalizeAvailability(
        offer?.availability ||
        item.availability,
      ),

    rating:
      parseNumericPrice(
        aggregateRating?.ratingValue,
      ),

    review_count:
      parseNumericPrice(
        aggregateRating?.reviewCount ||
        aggregateRating?.ratingCount,
      ),

    source: "json_ld",
  });
}

/**
 * Index only products contained in listing-oriented JSON-LD structures.
 *
 * We deliberately do not globally collect every standalone Product node,
 * because standalone nodes may come from recommendations or hidden widgets.
 */
function indexListingJsonLdByUrl(
  jsonLdBlocks = [],
  pageUrl = "",
) {
  const byUrl = new Map();

  const push = (item) => {
    const product = extractJsonLdProductRow(
      item,
      pageUrl,
    );

    if (!product?.url) return;

    const key = normalizeProductUrl(
      product.url,
      pageUrl,
    )?.toLowerCase();

    if (!key) return;

    if (!byUrl.has(key)) {
      byUrl.set(key, product);
      return;
    }

    byUrl.set(
      key,
      mergeProductRows(
        byUrl.get(key),
        product,
      ),
    );
  };

  const processListingNode = (node) => {
    const elements = []
      .concat(node.itemListElement || [])
      .concat(node.item || [])
      .concat(node.hasVariant || []);

    for (const element of elements) {
      const item = element?.item || element;

      if (
        item &&
        typeof item === "object"
      ) {
        push(item);
      }
    }
  };

  const walk = (node) => {
    if (
      !node ||
      typeof node !== "object"
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }

      return;
    }

    const types = getJsonLdTypes(node);

    const isListingNode =
      types.includes("itemlist") ||
      types.includes("offercatalog") ||
      types.includes("productgroup");

    if (isListingNode) {
      processListingNode(node);
    }

    for (
      const [key, value]
      of Object.entries(node)
    ) {
      if (key === "@context") continue;

      if (
        value &&
        typeof value === "object"
      ) {
        walk(value);
      }
    }
  };

  for (
    const block
    of [].concat(jsonLdBlocks || [])
  ) {
    walk(block);
  }

  return byUrl;
}

function extractListingFromJsonLd(
  jsonLdBlocks = [],
  pageUrl = "",
) {
  return [
    ...indexListingJsonLdByUrl(
      jsonLdBlocks,
      pageUrl,
    ).values(),
  ].slice(0, MAX_PRODUCTS);
}

function mergeProductRows(
  primary,
  secondary,
) {
  if (!primary) {
    return removeEmptyFields({
      ...secondary,
    });
  }

  if (!secondary) {
    return removeEmptyFields({
      ...primary,
    });
  }

  const merged = {
    ...secondary,
    ...primary,
  };

  for (
    const [key, value]
    of Object.entries(primary)
  ) {
    const empty =
      value === null ||
      value === undefined ||
      value === "" ||
      (
        Array.isArray(value) &&
        value.length === 0
      );

    if (
      empty &&
      secondary[key] !== null &&
      secondary[key] !== undefined
    ) {
      merged[key] = secondary[key];
    }
  }

  if (
    primary.source === "dom" &&
    secondary.source === "json_ld"
  ) {
    merged.source = "dom+json_ld";
  }

  return removeEmptyFields(merged);
}

/**
 * DOM products are the inventory source of truth.
 *
 * JSON-LD enriches matching URLs only. If DOM extraction is empty, structured
 * listing JSON-LD is used as a fallback.
 */
function enrichProductsFromJsonLd(
  domProducts,
  jsonLdBlocks,
  pageUrl,
) {
  const jsonLdByUrl =
    indexListingJsonLdByUrl(
      jsonLdBlocks,
      pageUrl,
    );

  if (!domProducts.length) {
    return [
      ...jsonLdByUrl.values(),
    ].slice(0, MAX_PRODUCTS);
  }

  return domProducts.map((domProduct) => {
    const key = normalizeProductUrl(
      domProduct.url,
      pageUrl,
    )?.toLowerCase();

    if (
      !key ||
      !jsonLdByUrl.has(key)
    ) {
      return {
        ...domProduct,
      };
    }

    return mergeProductRows(
      domProduct,
      jsonLdByUrl.get(key),
    );
  });
}

function formatPriceLine(product) {
  if (
    product.price !== null &&
    product.price !== undefined
  ) {
    return product.currency
      ? `${product.price} ${product.currency}`
      : String(product.price);
  }

  if (product.price_text) {
    return product.price_text;
  }

  return null;
}

function productToMarkdownBlock(product) {
  const name =
    cleanProductName(product.name) ||
    "Product";

  const lines = [
    `### ${name}`,
    `- Product name: ${name}`,
  ];

  const priceLine =
    formatPriceLine(product);

  if (priceLine) {
    lines.push(
      `- Price: ${priceLine}`,
    );
  }

  if (
    product.compare_at !== null &&
    product.compare_at !== undefined &&
    product.compare_at !== product.price
  ) {
    const currency = product.currency
      ? ` ${product.currency}`
      : "";

    lines.push(
      `- Was: ${product.compare_at}${currency}`,
    );
  }

  if (
    product.price_text &&
    product.price !== null &&
    product.price !== undefined &&
    cleanText(product.price_text) !==
      String(product.price)
  ) {
    lines.push(
      `- Displayed price: ${product.price_text}`,
    );
  }

  if (product.availability) {
    lines.push(
      `- Availability: ${product.availability}`,
    );
  }

  if (product.sku) {
    lines.push(
      `- SKU: ${product.sku}`,
    );
  }

  if (product.vendor) {
    lines.push(
      `- Brand: ${product.vendor}`,
    );
  }

  if (product.rating !== undefined) {
    lines.push(
      `- Rating: ${product.rating}`,
    );
  }

  if (
    product.review_count !== undefined
  ) {
    lines.push(
      `- Reviews: ${product.review_count}`,
    );
  }

  if (product.url) {
    lines.push(
      `- URL: ${product.url}`,
    );
  }

  if (product.image) {
    lines.push(
      `- Image: ${product.image}`,
    );
  }

  return lines.join("\n");
}

function buildListingHeader({
  title,
  pageUrl,
  products,
  description,
}) {
  const lines = [];

  if (title) {
    lines.push(`# ${title}`);
  }

  if (pageUrl) {
    lines.push(
      `\nURL: ${pageUrl}`,
    );
  }

  lines.push(
    `\nProducts on this page: ${products.length}`,
  );

  if (description) {
    lines.push("\n## About");
    lines.push(
      cleanText(description),
    );
  }

  return lines.join("\n").trim();
}

function buildListingIndex(products) {
  const lines = ["## Index"];

  if (!products.length) {
    lines.push(
      "_No products extracted._",
    );

    return lines.join("\n");
  }

  for (const product of products) {
    const name =
      cleanProductName(product.name) ||
      "Product";

    const priceLine =
      formatPriceLine(product);

    lines.push(
      priceLine
        ? `- ${name} — ${priceLine}`
        : `- ${name}`,
    );
  }

  return lines.join("\n");
}

function listingToMarkdown({
  title,
  pageUrl,
  products,
  description,
}) {
  const parts = [
    buildListingHeader({
      title,
      pageUrl,
      products,
      description,
    }),

    buildListingIndex(products),

    "## Products",
  ];

  if (!products.length) {
    parts.push(
      "_No products extracted._",
    );
  } else {
    for (const product of products) {
      parts.push(
        productToMarkdownBlock(product),
      );
    }
  }

  return stripInlineBufferImageContent(
    parts
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

/**
 * Adaptive products-per-child policy.
 *
 * Defaults:
 * - up to 20 products: 1 product per child
 * - 21–40 products: 4 products per child
 * - 41–150 products: 10 products per child
 * - 151–300 products: 12 products per child
 * - 301+ products: 15 products per child
 *
 * Therefore:
 * - 50 products => approximately 5 product chunks
 * - 100 products => approximately 10 product chunks
 */
function resolveListingBatchSize(
  productCount,
) {
  const count =
    Number(productCount) || 0;

  const onePerChildMax =
    parseInt(
      process.env
        .LISTING_ONE_PER_CHILD_MAX ||
        "20",
      10,
    ) || 20;

  const smallMax =
    parseInt(
      process.env
        .LISTING_BATCH_SMALL_MAX ||
        "40",
      10,
    ) || 40;

  const mediumMax =
    parseInt(
      process.env
        .LISTING_BATCH_MEDIUM_MAX ||
        "150",
      10,
    ) || 150;

  const largeMax =
    parseInt(
      process.env
        .LISTING_BATCH_LARGE_MAX ||
        "300",
      10,
    ) || 300;

  if (count <= onePerChildMax) {
    return 1;
  }

  if (count <= smallMax) {
    return (
      parseInt(
        process.env
          .LISTING_BATCH_SIZE_SMALL ||
          "4",
        10,
      ) || 4
    );
  }

  if (count <= mediumMax) {
    return (
      parseInt(
        process.env
          .LISTING_BATCH_SIZE_MEDIUM ||
          "10",
        10,
      ) || 10
    );
  }

  if (count <= largeMax) {
    return (
      parseInt(
        process.env
          .LISTING_BATCH_SIZE_LARGE ||
          "12",
        10,
      ) || 12
    );
  }

  return (
    parseInt(
      process.env
        .LISTING_BATCH_SIZE_XLARGE ||
        "15",
      10,
    ) || 15
  );
}

/**
 * Prefer clean page headings over a title value polluted by footer/payment
 * text.
 */
function resolveListingTitle(
  title,
  html,
  pageUrl,
) {
  if (html) {
    const $ = cheerio.load(html);

    const h1 = cleanText(
      $(
        [
          "main h1",
          "#MainContent h1",
          "[role='main'] h1",
          "h1",
        ].join(", "),
      )
        .first()
        .text(),
    );

    if (
      h1 &&
      h1.length <= 160
    ) {
      return h1;
    }

    const ogTitle = cleanText(
      $(
        'meta[property="og:title"]',
      ).attr("content"),
    );

    if (
      ogTitle &&
      ogTitle.length <= 200
    ) {
      return ogTitle;
    }

    const documentTitle = cleanText(
      $("title").first().text(),
    );

    if (
      documentTitle &&
      documentTitle.length <= 200
    ) {
      return documentTitle;
    }
  }

  const providedTitle =
    cleanText(title);

  if (
    providedTitle &&
    providedTitle !== pageUrl &&
    providedTitle.length <= 200 &&
    !/^https?:\/\//i.test(
      providedTitle,
    )
  ) {
    return providedTitle;
  }

  return "Product listing";
}

function extractPageDescription($) {
  const selectors = [
    ".collection-description",
    ".category-description",
    ".collection__description",
    "[data-collection-description]",
    ".page-description",
    "main .rte",
  ];

  for (const selector of selectors) {
    const description = cleanText(
      $(selector).first().text(),
    );

    if (
      description.length >= 20 &&
      description.length <= 3000
    ) {
      return description;
    }
  }

  return null;
}

function slimProduct(product) {
  if (
    !product ||
    typeof product !== "object"
  ) {
    return null;
  }

  return removeEmptyFields({
    name: product.name,
    url: product.url,

    price: product.price,
    compare_at: product.compare_at,
    currency: product.currency,
    price_text: product.price_text,

    sku: product.sku,
    product_id: product.product_id,
    handle: product.handle,
    vendor: product.vendor,

    availability:
      product.availability,

    image: product.image,
    image_alt: product.image_alt,

    rating: product.rating,
    review_count:
      product.review_count,
  });
}

function calculateConfidence({
  products,
  domCount,
  jsonLdCount,
}) {
  if (!products.length) {
    return 0.2;
  }

  const namedCount = products.filter(
    (product) => product.name,
  ).length;

  const urlCount = products.filter(
    (product) => product.url,
  ).length;

  const pricedCount = products.filter(
    (product) =>
      product.price !== null &&
      product.price !== undefined,
  ).length;

  let confidence = 0.5;

  if (products.length >= 3) {
    confidence += 0.15;
  }

  if (namedCount === products.length) {
    confidence += 0.1;
  }

  if (urlCount === products.length) {
    confidence += 0.1;
  }

  if (
    pricedCount >=
    Math.ceil(products.length * 0.5)
  ) {
    confidence += 0.05;
  }

  if (
    domCount &&
    jsonLdCount
  ) {
    confidence += 0.05;
  }

  return Math.min(
    Number(confidence.toFixed(2)),
    0.95,
  );
}

/**
 * Main listing extractor.
 */
function extractListingContent({
  url,
  html,
  jsonLdBlocks = [],
  title = null,
  metaDescription = null,
} = {}) {
  const fromDom =
    extractListingFromDom(
      html,
      url,
    );

  const jsonLdIndex =
    indexListingJsonLdByUrl(
      jsonLdBlocks,
      url,
    );

  const unboundedProducts =
    enrichProductsFromJsonLd(
      fromDom,
      jsonLdBlocks,
      url,
    );

  const products =
    unboundedProducts.slice(
      0,
      MAX_PRODUCTS,
    );

  const entityName =
    resolveListingTitle(
      title,
      html,
      url,
    );

  let description =
    cleanText(metaDescription);

  if (!description && html) {
    const $ = cheerio.load(html);

    description =
      extractPageDescription($) || "";
  }

  const slimProducts = products
    .map(slimProduct)
    .filter(Boolean);

  const content = listingToMarkdown({
    title: entityName,
    pageUrl: url,
    products,
    description,
  });

  const enrichedCount =
    products.filter(
      (product) =>
        product.source ===
        "dom+json_ld",
    ).length;

  let extractionSource =
    "listing_empty";

  if (
    fromDom.length &&
    jsonLdIndex.size
  ) {
    extractionSource =
      enrichedCount > 0
        ? "dom_listing+json_ld_enrichment"
        : "dom_listing";
  } else if (fromDom.length) {
    extractionSource =
      "dom_listing";
  } else if (jsonLdIndex.size) {
    extractionSource =
      "json_ld_listing_fallback";
  }

  const productsTruncated =
    unboundedProducts.length >
    MAX_PRODUCTS;

  const attributes = {
    product_urls: products
      .map((product) => product.url)
      .filter(Boolean),

    product_count:
      products.length,

    extracted_product_count:
      unboundedProducts.length,

    indexed_product_count:
      products.length,

    products_truncated:
      productsTruncated,

    products: slimProducts,

    listing_batch_size:
      resolveListingBatchSize(
        products.length,
      ),

    priced_product_count:
      products.filter(
        (product) =>
          product.price !== null &&
          product.price !== undefined,
      ).length,

    available_product_count:
      products.filter(
        (product) =>
          product.availability ===
          "in_stock",
      ).length,

    unavailable_product_count:
      products.filter(
        (product) =>
          product.availability ===
          "out_of_stock",
      ).length,

    diagnostics: {
      dom_product_count:
        fromDom.length,

      json_ld_product_count:
        jsonLdIndex.size,

      enriched_product_count:
        enrichedCount,
    },
  };

  return {
    content,

    entity_name:
      entityName,

    attributes,

    products,

    extraction_source:
      extractionSource,

    extraction_confidence:
      calculateConfidence({
        products,
        domCount: fromDom.length,
        jsonLdCount:
          jsonLdIndex.size,
      }),
  };
}

module.exports = {
  extractListingContent,

  extractListingFromJsonLd,
  extractListingFromDom,
  enrichProductsFromJsonLd,

  listingToMarkdown,
  productToMarkdownBlock,
  buildListingHeader,
  buildListingIndex,

  resolveListingBatchSize,
  slimProduct,

  normalizeProductUrl,
  isLikelyProductUrl,
  parsePrice,

  GRID_SELECTORS,
  CARD_CONTEXT_SELECTORS,
  MAX_PRODUCTS,
};