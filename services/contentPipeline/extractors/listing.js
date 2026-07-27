// const cheerio = require("cheerio");
// const urlModule = require("url");
// const {
//   stripInlineBufferImageContent,
//   FACET_SIDEBAR_SELECTORS,
// } = require("../htmlCleanup");

// const MAX_PRODUCTS = 60;

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
//   ".collection-grid",
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

// function cleanText(s) {
//   return String(s || "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function parsePrice(text) {
//   const m = String(text || "")
//     .replace(/,/g, "")
//     .match(/(\d+(?:\.\d+)?)/);
//   return m ? Number(m[1]) : null;
// }

// /**
//  * Collect product entities from ItemList / ProductGroup / OfferCatalog JSON-LD.
//  */
// function extractListingFromJsonLd(jsonLdBlocks = [], pageUrl = "") {
//   const products = [];
//   const seen = new Set();

//   const push = (item) => {
//     if (!item || typeof item !== "object") return;
//     const name = cleanText(item.name || item.title || "");
//     const url = absolutize(
//       typeof item.url === "string"
//         ? item.url
//         : item["@id"] || item.offerUrl || null,
//       pageUrl,
//     );
//     const offer =
//       item.offers && typeof item.offers === "object"
//         ? Array.isArray(item.offers)
//           ? item.offers[0]
//           : item.offers
//         : null;
//     const price =
//       offer?.price != null
//         ? Number(offer.price)
//         : offer?.lowPrice != null
//           ? Number(offer.lowPrice)
//           : null;
//     const key = (url || name).toLowerCase();
//     if (!name && !url) return;
//     if (seen.has(key)) return;
//     seen.add(key);
//     const row = { name: name || null, url: url || null };
//     if (price != null && !Number.isNaN(price)) row.price = price;
//     products.push(row);
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
//       for (const el of els) {
//         const item = el?.item || el;
//         push(item);
//       }
//     }
//     if (types.includes("productgroup")) {
//       for (const v of [].concat(node.hasVariant || node.variesBy || [])) {
//         push(v);
//       }
//     }
//     if (types.includes("product") && (node.url || node.name)) {
//       // Collection pages sometimes list many Product nodes
//       push(node);
//     }
//     for (const [k, v] of Object.entries(node)) {
//       if (k === "@context") continue;
//       if (v && typeof v === "object") walk(v);
//     }
//   };

//   for (const block of [].concat(jsonLdBlocks || [])) walk(block);
//   return products.slice(0, MAX_PRODUCTS);
// }

// function extractCard($, el, pageUrl) {
//   const $el = $(el);
//   // Prefer product PDP links over collection/filter links
//   let href = null;
//   $el.find("a[href]").each((_, a) => {
//     if (href) return;
//     const h = ($(a).attr("href") || "").trim();
//     if (/\/products?\//i.test(h) || /\/p\//i.test(h)) href = h;
//   });
//   if (!href) {
//     href = $el.find("a[href]").first().attr("href") || null;
//   }
//   const url = absolutize(href, pageUrl);

//   const name = cleanText(
//     $el.find(".card__heading, .product-card__title, .product-title, .product-item__title, h2, h3, .card__title, [itemprop='name']").first().text() ||
//       $el.find("a[href*='/products/']").first().text() ||
//       $el.find("img[alt]").first().attr("alt") ||
//       "",
//   );

//   const priceText =
//     $el.find("[itemprop='price'], .price, .price-item, .product-price, .money").first().text() ||
//     "";
//   const price = parsePrice(priceText);

//   if (!name && !url) return null;
//   // Skip pure nav / filter cards
//   if (name && /^(clear|apply|filter|sort|collections?)$/i.test(name)) return null;

//   const row = { name: name || null, url: url || null };
//   if (price != null && !Number.isNaN(price)) row.price = price;
//   return row;
// }

// /**
//  * DOM fallback: product grid / cards on collection & catalog pages.
//  */
// function extractListingFromDom(html, pageUrl = "") {
//   if (!html) return [];
//   const $ = cheerio.load(html);

//   // Drop facet / filter chrome so cards aren't confused with filter rows
//   if (FACET_SIDEBAR_SELECTORS) {
//     $(FACET_SIDEBAR_SELECTORS).remove();
//   }
//   $("header, footer, nav, script, style, noscript").remove();

//   const products = [];
//   const seen = new Set();

//   const push = (row) => {
//     if (!row) return;
//     const key = (row.url || row.name || "").toLowerCase();
//     if (!key || seen.has(key)) return;
//     seen.add(key);
//     products.push(row);
//   };

//   const $grid = $(GRID_SELECTORS).first();
//   const scope = $grid.length ? $grid : $.root();

//   let cards = scope.find(CARD_SELECTORS).toArray();
//   // Prefer outermost cards — drop nested card matches
//   cards = cards.filter((el) => $(el).parents(CARD_SELECTORS).length === 0);

//   if (cards.length === 0) {
//     // Fallback: any /products/ link blocks in main
//     const $main = $("main, [role='main'], #MainContent, .main-content").first();
//     const root = $main.length ? $main : $.root();
//     root.find("a[href*='/products/'], a[href*='/product/']").each((_, a) => {
//       const url = absolutize($(a).attr("href"), pageUrl);
//       const name = cleanText($(a).text() || $(a).find("img").attr("alt") || "");
//       if (!url) return;
//       // Use closest list item / article as card context for price
//       const $card = $(a).closest("li, article, .grid__item, .card, div");
//       const price = parsePrice(
//         $card.find(".price, .money, [itemprop='price']").first().text() || "",
//       );
//       const row = { name: name || null, url };
//       if (price != null) row.price = price;
//       push(row);
//     });
//   } else {
//     for (const el of cards) {
//       push(extractCard($, el, pageUrl));
//       if (products.length >= MAX_PRODUCTS) break;
//     }
//   }

//   return products.slice(0, MAX_PRODUCTS);
// }

// function listingToMarkdown({ title, pageUrl, products, description }) {
//   const lines = [];
//   if (title) lines.push(`# ${title}`);
//   if (pageUrl) lines.push(`\nURL: ${pageUrl}`);
//   if (description) {
//     lines.push("\n## About");
//     lines.push(description.trim());
//   }

//   lines.push("\n## Products");
//   if (!products.length) {
//     lines.push("_No products extracted._");
//   } else {
//     for (const p of products) {
//       const bits = [];
//       if (p.name) bits.push(p.name);
//       if (p.price != null) bits.push(`Price: ${p.price}`);
//       if (p.url) bits.push(p.url);
//       lines.push(`- ${bits.join(" — ")}`);
//     }
//   }

//   return stripInlineBufferImageContent(
//     lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
//   );
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
//  * PLP / collection listing extraction.
//  * Prefer JSON-LD item lists; fall back to product grid DOM cards.
//  * Facet sidebars are stripped — not indexed as content.
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
//   const fromLd = extractListingFromJsonLd(jsonLdBlocks, url);
//   const fromDom = extractListingFromDom(html, url);

//   // Merge: JSON-LD first, fill gaps from DOM
//   const byKey = new Map();
//   for (const p of [...fromLd, ...fromDom]) {
//     const key = (p.url || p.name || "").toLowerCase();
//     if (!key) continue;
//     if (!byKey.has(key)) {
//       byKey.set(key, { ...p });
//     } else {
//       const prev = byKey.get(key);
//       byKey.set(key, {
//         name: prev.name || p.name,
//         url: prev.url || p.url,
//         price: prev.price != null ? prev.price : p.price,
//       });
//     }
//   }
//   const products = [...byKey.values()].slice(0, MAX_PRODUCTS);

//   const entity_name = resolveListingTitle(title, html, url);

//   const attributes = {
//     product_urls: products.map((p) => p.url).filter(Boolean).slice(0, MAX_PRODUCTS),
//     product_count: products.length,
//     products: products.slice(0, MAX_PRODUCTS),
//   };

//   const content = listingToMarkdown({
//     title: entity_name,
//     pageUrl: url,
//     products,
//     description: metaDescription || "",
//   });

//   const source =
//     fromLd.length && fromDom.length
//       ? "json_ld+dom_listing"
//       : fromLd.length
//         ? "json_ld_listing"
//         : fromDom.length
//           ? "dom_listing"
//           : "listing_empty";

//   return {
//     content,
//     entity_name,
//     attributes,
//     products,
//     extraction_source: source,
//     extraction_confidence: products.length >= 3 ? 0.85 : products.length ? 0.65 : 0.3,
//   };
// }

// module.exports = {
//   extractListingContent,
//   extractListingFromJsonLd,
//   extractListingFromDom,
//   listingToMarkdown,
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

// Display/content cap — how many products render in markdown and the
// primary `product_urls` attribute. Kept small so the section stays a
// reasonable chunk size.
const MAX_PRODUCTS = 60;

// Safety cap on total cards *scanned* across all matching grids on the page.
// Independent from MAX_PRODUCTS: scanning can go higher so nothing past the
// display cap silently disappears — the full list is preserved in
// `attributes.all_product_urls` even when only MAX_PRODUCTS are shown.
const MAX_SCAN_PRODUCTS = 500;

// On-page collection/category description copy. Checked before falling back
// to metaDescription, since PLPs often carry real intro prose here that
// metaDescription alone misses.
const DESCRIPTION_SELECTORS = [
  ".collection-description",
  ".collection__description",
  ".collection-hero__description",
  "[data-collection-description]",
  "#collection-description",
  ".category-description",
].join(", ");

// Lines that look like UI chrome ("Showing 1-24 of 137 products", "Sort by")
// rather than real descriptive copy — skip these when scanning for a prose
// fallback near the H1.
const DESCRIPTION_NOISE_RE =
  /^(showing|sort by|sort:|filter|\d+\s+(products?|items?|results?)\s*(found)?$)/i;

const GRID_SELECTORS = [
  "#ProductGridContainer",
  "#product-grid",
  ".product-grid",
  ".product-list",
  ".collection-products",
  ".collection__products",
  "[data-product-grid]",
  ".products-list",
  ".product-items",
  "ul.products",
  ".collection-grid",
].join(", ");

const CARD_SELECTORS = [
  ".product-card",
  ".product-item",
  ".grid__item .card",
  ".grid__item",
  "[data-product-id]",
  "[data-product-handle]",
  "li.product",
  ".card-wrapper",
  ".product-block",
].join(", ");

function absolutize(href, pageUrl) {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) {
    return null;
  }
  try {
    return urlModule.resolve(pageUrl || "", raw);
  } catch {
    return raw;
  }
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(text) {
  const m = String(text || "")
    .replace(/,/g, "")
    .match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Collect product entities from ItemList / ProductGroup / OfferCatalog JSON-LD.
 */
function extractListingFromJsonLd(jsonLdBlocks = [], pageUrl = "") {
  const products = [];
  const seen = new Set();

  const push = (item) => {
    if (!item || typeof item !== "object") return;
    const name = cleanText(item.name || item.title || "");
    const url = absolutize(
      typeof item.url === "string"
        ? item.url
        : item["@id"] || item.offerUrl || null,
      pageUrl,
    );
    const offer =
      item.offers && typeof item.offers === "object"
        ? Array.isArray(item.offers)
          ? item.offers[0]
          : item.offers
        : null;
    const price =
      offer?.price != null
        ? Number(offer.price)
        : offer?.lowPrice != null
          ? Number(offer.lowPrice)
          : null;
    const key = (url || name).toLowerCase();
    if (!name && !url) return;
    if (seen.has(key)) return;
    seen.add(key);
    const row = { name: name || null, url: url || null };
    if (price != null && !Number.isNaN(price)) row.price = price;
    products.push(row);
  };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const types = []
      .concat(node["@type"] || [])
      .map((t) =>
        String(t || "")
          .toLowerCase()
          .replace(/^https?:\/\/schema\.org\//, ""),
      );

    if (types.includes("itemlist") || types.includes("offercatalog")) {
      const els = [].concat(node.itemListElement || node.item || []);
      for (const el of els) {
        const item = el?.item || el;
        push(item);
      }
    }
    if (types.includes("productgroup")) {
      for (const v of [].concat(node.hasVariant || node.variesBy || [])) {
        push(v);
      }
    }
    if (types.includes("product") && (node.url || node.name)) {
      // Collection pages sometimes list many Product nodes
      push(node);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "@context") continue;
      if (v && typeof v === "object") walk(v);
    }
  };

  for (const block of [].concat(jsonLdBlocks || [])) walk(block);
  return products.slice(0, MAX_SCAN_PRODUCTS);
}

function extractCard($, el, pageUrl) {
  const $el = $(el);
  // Prefer product PDP links over collection/filter links
  let href = null;
  $el.find("a[href]").each((_, a) => {
    if (href) return;
    const h = ($(a).attr("href") || "").trim();
    if (/\/products?\//i.test(h) || /\/p\//i.test(h)) href = h;
  });
  if (!href) {
    href = $el.find("a[href]").first().attr("href") || null;
  }
  const url = absolutize(href, pageUrl);

  const name = cleanText(
    $el.find(".card__heading, .product-card__title, .product-title, .product-item__title, h2, h3, .card__title, [itemprop='name']").first().text() ||
      $el.find("a[href*='/products/']").first().text() ||
      $el.find("img[alt]").first().attr("alt") ||
      "",
  );

  const priceText =
    $el.find("[itemprop='price'], .price, .price-item, .product-price, .money").first().text() ||
    "";
  const price = parsePrice(priceText);

  if (!name && !url) return null;
  // Skip pure nav / filter cards
  if (name && /^(clear|apply|filter|sort|collections?)$/i.test(name)) return null;

  const row = { name: name || null, url: url || null };
  if (price != null && !Number.isNaN(price)) row.price = price;
  return row;
}

/**
 * DOM fallback: product grid / cards on collection & catalog pages.
 */
function extractListingFromDom(html, pageUrl = "") {
  if (!html) return [];
  const $ = cheerio.load(html);

  // Drop facet / filter chrome so cards aren't confused with filter rows
  if (FACET_SIDEBAR_SELECTORS) {
    $(FACET_SIDEBAR_SELECTORS).remove();
  }
  $("header, footer, nav, script, style, noscript").remove();

  const products = [];
  const seen = new Set();

  const push = (row) => {
    if (!row) return;
    const key = (row.url || row.name || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    products.push(row);
  };

  const $grids = $(GRID_SELECTORS);
  let anyCardsFound = false;

  if ($grids.length) {
    $grids.each((_, gridEl) => {
      if (products.length >= MAX_SCAN_PRODUCTS) return false; // stop .each()

      const scope = $(gridEl);
      let cards = scope.find(CARD_SELECTORS).toArray();
      // Prefer outermost cards — drop nested card matches
      cards = cards.filter((el) => $(el).parents(CARD_SELECTORS).length === 0);
      if (cards.length) anyCardsFound = true;

      for (const el of cards) {
        push(extractCard($, el, pageUrl));
        if (products.length >= MAX_SCAN_PRODUCTS) break;
      }
    });
  }

  if (!anyCardsFound) {
    // Fallback: any /products/ link blocks in main
    const $main = $("main, [role='main'], #MainContent, .main-content").first();
    const root = $main.length ? $main : $.root();
    root.find("a[href*='/products/'], a[href*='/product/']").each((_, a) => {
      if (products.length >= MAX_SCAN_PRODUCTS) return false;
      const url = absolutize($(a).attr("href"), pageUrl);
      const name = cleanText($(a).text() || $(a).find("img").attr("alt") || "");
      if (!url) return;
      // Use closest list item / article as card context for price
      const $card = $(a).closest("li, article, .grid__item, .card, div");
      const price = parsePrice(
        $card.find(".price, .money, [itemprop='price']").first().text() || "",
      );
      const row = { name: name || null, url };
      if (price != null) row.price = price;
      push(row);
    });
  }

  return products.slice(0, MAX_SCAN_PRODUCTS);
}

/**
 * On-page collection/category description prose — checked before falling
 * back to metaDescription. Tries known theme selectors first, then a
 * heuristic scan for a substantial paragraph sitting between the H1 and the
 * product grid.
 */
function extractOnPageDescription(html, pageUrl = "") {
  if (!html) return "";
  const $ = cheerio.load(html);
  if (FACET_SIDEBAR_SELECTORS) $(FACET_SIDEBAR_SELECTORS).remove();
  $("header, footer, nav, script, style, noscript").remove();

  const known = cleanText($(DESCRIPTION_SELECTORS).first().text());
  if (known && known.length >= 20) return known.slice(0, 1000);

  const $grid = $(GRID_SELECTORS).first();
  const $h1 = $("h1").first();
  let $node = $h1.length ? $h1.next() : null;
  let hops = 0;

  while ($node && $node.length && hops < 12) {
    if ($grid.length && $node.get(0) === $grid.get(0)) break;
    if ($node.is("p, div")) {
      const text = cleanText($node.text());
      if (
        text.length >= 20 &&
        text.length <= 1000 &&
        !DESCRIPTION_NOISE_RE.test(text) &&
        $node.find(CARD_SELECTORS).length === 0
      ) {
        return text;
      }
    }
    $node = $node.next();
    hops += 1;
  }

  return "";
}

function listingToMarkdown({ title, pageUrl, products, description }) {
  const lines = [];
  if (title) lines.push(`# ${title}`);
  if (pageUrl) lines.push(`\nURL: ${pageUrl}`);
  if (description) {
    lines.push("\n## About");
    lines.push(description.trim());
  }

  lines.push("\n## Products");
  if (!products.length) {
    lines.push("_No products extracted._");
  } else {
    for (const p of products) {
      const bits = [];
      if (p.name) bits.push(p.name);
      if (p.price != null) bits.push(`Price: ${p.price}`);
      if (p.url) bits.push(p.url);
      lines.push(`- ${bits.join(" — ")}`);
    }
  }

  return stripInlineBufferImageContent(
    lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  );
}

function resolveListingTitle(title, html, pageUrl) {
  const t = cleanText(title || "");
  if (t && t !== pageUrl && !/^https?:\/\//i.test(t)) return t;

  if (html) {
    const $ = cheerio.load(html);
    const h1 = cleanText($("h1").first().text());
    if (h1 && h1.length < 120) return h1;
    const og = cleanText($('meta[property="og:title"]').attr("content"));
    if (og && !/^https?:\/\//i.test(og)) return og;
  }
  return "Product listing";
}

/**
 * PLP / collection listing extraction.
 * Prefer JSON-LD item lists; fall back to product grid DOM cards.
 * Facet sidebars are stripped — not indexed as content.
 *
 * @returns {{ content, entity_name, attributes, products, extraction_source, extraction_confidence }}
 */
function extractListingContent({
  url,
  html,
  jsonLdBlocks = [],
  title = null,
  metaDescription = null,
} = {}) {
  const fromLd = extractListingFromJsonLd(jsonLdBlocks, url);
  const fromDom = extractListingFromDom(html, url);

  // Merge: JSON-LD first, fill gaps from DOM
  const byKey = new Map();
  for (const p of [...fromLd, ...fromDom]) {
    const key = (p.url || p.name || "").toLowerCase();
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { ...p });
    } else {
      const prev = byKey.get(key);
      byKey.set(key, {
        name: prev.name || p.name,
        url: prev.url || p.url,
        price: prev.price != null ? prev.price : p.price,
      });
    }
  }
  // Full merged list, uncapped up to the MAX_SCAN_PRODUCTS safety limit
  // already applied inside each extractor. Nothing here silently drops
  // products past 60 — that only happens at the display slice below.
  const allProducts = [...byKey.values()];
  const displayProducts = allProducts.slice(0, MAX_PRODUCTS);

  const entity_name = resolveListingTitle(title, html, url);
  const onPageDescription = extractOnPageDescription(html, url);

  const attributes = {
    product_urls: displayProducts.map((p) => p.url).filter(Boolean),
    // Uncapped — for downstream use (e.g. "show all products" answers,
    // future pagination follow-up) even though only MAX_PRODUCTS render
    // in `content` below.
    all_product_urls: allProducts.map((p) => p.url).filter(Boolean),
    product_count: allProducts.length,
    displayed_product_count: displayProducts.length,
    products: displayProducts,
  };

  const content = listingToMarkdown({
    title: entity_name,
    pageUrl: url,
    products: displayProducts,
    description: onPageDescription || metaDescription || "",
  });

  const source =
    fromLd.length && fromDom.length
      ? "json_ld+dom_listing"
      : fromLd.length
        ? "json_ld_listing"
        : fromDom.length
          ? "dom_listing"
          : "listing_empty";

  return {
    content,
    entity_name,
    attributes,
    products: displayProducts,
    extraction_source: source,
    extraction_confidence:
      allProducts.length >= 3 ? 0.85 : allProducts.length ? 0.65 : 0.3,
  };
}

module.exports = {
  extractListingContent,
  extractListingFromJsonLd,
  extractListingFromDom,
  extractOnPageDescription,
  listingToMarkdown,
  GRID_SELECTORS,
  CARD_SELECTORS,
  MAX_PRODUCTS,
  MAX_SCAN_PRODUCTS,
};