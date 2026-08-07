const cheerio = require("cheerio");
const urlModule = require("url");
const {
  stripInlineBufferImageContent,
  FACET_SIDEBAR_SELECTORS,
} = require("../htmlCleanup");

const MAX_PRODUCTS = 60;

const GRID_SELECTORS = [
  // Shopify
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
  ".products",
  ".shop-grid",
  ".grid--view-items",
  // BigCommerce
  ".productGrid",
  ".productBlockContainer",
  "#product-listing-container",
  "ul.productGrid",
  "#product-listing-container .productGrid",
  // WooCommerce
  ".woocommerce-page ul.products",
  ".wc-block-grid__products",
  "ul.products",
  // Magento
  ".products-grid",
  "ol.products",
  ".product-items",
  // Salesforce Commerce Cloud & Generic
  ".search-results",
  ".product-grid-container",
  "[class*='product-grid' i]",
  "[class*='productGrid' i]",
  "[class*='productList' i]",
  "[class*='products-grid' i]",
  "[class*='grid-products' i]",
  "[class*='productListing' i]",
  "[class*='category-products' i]",
].join(", ");

const CARD_SELECTORS = [
  // Shopify
  ".product-card",
  ".product-item",
  ".grid__item .card",
  ".grid__item",
  "[data-product-id]",
  "[data-product-handle]",
  "li.product",
  ".card-wrapper",
  ".product-block",
  // BigCommerce
  "article.card",
  ".card-body",
  ".productCard",
  "[data-test-info-type='brandName']",
  // WooCommerce
  "li.product",
  ".type-product",
  ".wc-block-grid__product-template",
  // Magento & SFCC
  "li.product-item",
  ".product-item-info",
  ".product-tile",
  ".product-tile-body",
  // Generic / Custom
  ".product-box",
  ".shop-item",
  ".product-col",
  ".product-card-wrapper",
  "[class*='product-card' i]",
  "[class*='product-item' i]",
  "[class*='productCard' i]",
  "[class*='productItem' i]",
  "[class*='productTile' i]",
  "[class*='product_card' i]",
  "[class*='productBlock' i]",
  "article.product",
  "li.product-item",
  ".type-product",
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

function extractCurrencySymbol(text = "") {
  const str = String(text || "").trim();
  if (/₹|rs\.?|inr/i.test(str)) return "₹";
  if (/€|eur/i.test(str)) return "€";
  if (/£|gbp/i.test(str)) return "£";
  if (/\$|usd|cad|aud/i.test(str)) return "$";
  if (/¥|jpy|cny/i.test(str)) return "¥";
  if (/₩|krw/i.test(str)) return "₩";
  if (/₪|ils/i.test(str)) return "₪";
  if (/฿|thb/i.test(str)) return "฿";
  if (/₫|vnd/i.test(str)) return "₫";
  if (/₱|php/i.test(str)) return "₱";
  return "";
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
    if (price != null && !Number.isNaN(price)) {
      row.price = price;
      const symbol = extractCurrencySymbol(offer?.priceCurrency || "");
      if (symbol) row.currency = symbol;
    }
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
  return products.slice(0, MAX_PRODUCTS);
}

function extractPriceFromCard($, $el) {
  // 1. Try leaf price elements containing numbers
  const priceElements = $el
    .find(
      "[data-product-price-without-tax], [data-product-price], [itemprop='price'], .price--withoutTax, .price--withTax, .price-item--sale, .price-item--regular, .price, .money, .amount, [class*='price' i]",
    )
    .toArray();

  for (const pEl of priceElements) {
    const text = cleanText($(pEl).text());
    const num = parsePrice(text);
    if (num != null && !Number.isNaN(num) && num > 0) {
      const currency = extractCurrencySymbol(text) || "$";
      return { price: num, currency };
    }
  }

  // 2. Fallback: match currency regex ($16,920.00 / ₹900 / €49.99) in card text
  const fullText = cleanText($el.text());
  const match = fullText.match(/(?:(₹|\$|€|£|¥|Rs\.?)\s*)?([\d,]+(?:\.\d+)?)/i);
  if (match) {
    const parsed = parsePrice(match[2]);
    if (parsed != null && !Number.isNaN(parsed) && parsed > 0) {
      const currency = extractCurrencySymbol(match[1] || fullText) || "$";
      return { price: parsed, currency };
    }
  }

  return { price: null, currency: "" };
}

function extractCard($, el, pageUrl) {
  const $el = $(el);
  // Prefer product PDP links over collection/filter links
  let href = null;
  $el.find("a[href]").each((_, a) => {
    if (href) return;
    const h = ($(a).attr("href") || "").trim();
    if (/\/products?\/|\/p\/|\/item\/|\/shop\/|\/pd\/|\/goods\/|\/[a-z0-9-]+-[0-9]+\//i.test(h)) href = h;
  });
  if (!href) {
    $el.find("a[href]").each((_, a) => {
      if (href) return;
      const h = ($(a).attr("href") || "").trim();
      if (h && !h.startsWith("#") && !h.toLowerCase().startsWith("javascript:")) {
        const isNav = /\/(account|login|register|cart|checkout|policies|blogs|search|wishlist)(\/|$|\?)/i.test(h);
        if (!isNav) href = h;
      }
    });
  }
  const url = absolutize(href, pageUrl);

  const name = cleanText(
    $el.find("h4.card-title, .card-title, .product-item-name, .woocommerce-loop-product__title, .wc-block-grid__product-title, .pdp-link a, .card__heading, .product-card__title, .product-title, .product-item__title, .product-name, .item-name, .name, .title, [class*='title' i], [class*='name' i], h2, h3, h4, h5, [itemprop='name']").first().text() ||
      $el.find("a[href]").first().text() ||
      $el.find("img[alt]").first().attr("alt") ||
      "",
  );

  const { price, currency } = extractPriceFromCard($, $el);

  if (!name && !url) return null;
  // Exclude account/login/cart/nav links
  if (url && /\/(account|login|register|cart|checkout|policies|blogs|search|wishlist)(\/|$|\?)/i.test(url)) {
    return null;
  }
  if (name && /^(log in|sign in|account|cart|checkout|search|view all|privacy|terms|menu|close|filter|sort|collections?)$/i.test(name.trim())) {
    return null;
  }

  const row = { name: name || null, url: url || null };
  if (price != null && !Number.isNaN(price)) {
    row.price = price;
    if (currency) row.currency = currency;
  }
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
  $("header, footer, nav, script, style, noscript, localization-form, .localization-form").remove();

  const products = [];
  const seen = new Set();

  const push = (row) => {
    if (!row || (!row.name && !row.url)) return;
    if (row.url && /\/(account|login|register|cart|checkout|policies|blogs|search|wishlist)(\/|$|\?)/i.test(row.url)) {
      return;
    }
    if (row.name && /^(log in|sign in|account|cart|checkout|search|view all|privacy|terms|menu|close|filter|sort|collections?)$/i.test(row.name.trim())) {
      return;
    }
    const key = (row.url || row.name || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    products.push(row);
  };

  const $grid = $(GRID_SELECTORS).first();
  const scope = $grid.length ? $grid : $.root();

  let cards = scope.find(CARD_SELECTORS).toArray();

  if (cards.length > 0) {
    for (const el of cards) {
      push(extractCard($, el, pageUrl));
      if (products.length >= MAX_PRODUCTS) break;
    }
  }

  if (products.length === 0) {
    // Fallback: any product link blocks in main/body
    const $main = $("main, [role='main'], #MainContent, .main-content, body").first();
    const root = $main.length ? $main : $.root();
    root.find("a[href*='/product/'], a[href*='/products/'], a[href*='/p/'], a[href*='/item/'], a[href*='/shop/'], a[href*='/pd/']").each((_, a) => {
      const url = absolutize($(a).attr("href"), pageUrl);
      const name = cleanText($(a).text() || $(a).find("img").attr("alt") || "");
      if (!url) return;
      // Use closest list item / article as card context for price
      const $card = $(a).closest("li, article, .grid__item, .card, div");
      const { price, currency } = extractPriceFromCard($, $card);
      const row = { name: name || null, url };
      if (price != null) {
        row.price = price;
        if (currency) row.currency = currency;
      }
      push(row);
    });
  }

  return products.slice(0, MAX_PRODUCTS);
}

function listingToMarkdown({ title, pageUrl, products, description }) {
  const lines = [];
  const cleanTitle = title || "Product Collection";
  lines.push(`# ${cleanTitle}`);

  if (pageUrl) {
    lines.push(`\nCollection URL:\n${pageUrl}`);
  }

  if (description && description.trim()) {
    lines.push(`\nDescription:\n${description.trim()}`);
  }

  if (!products || !products.length) {
    lines.push("\n## Product\n\n_No products extracted._");
  } else {
    for (const p of products) {
      lines.push("\n## Product");

      if (p.name) {
        lines.push(`\nName:\n${p.name}`);
      }

      if (p.price != null) {
        const cur = p.currency ? p.currency : "$";
        const formatted = /^[$\u20AC\u00A3\u20B9\u00A5\u20A9\u20AA\u0E3F\u20AB\u20B1]/i.test(cur)
          ? `${cur}${p.price}`
          : `${p.price} ${cur}`;
        lines.push(`\nPrice:\n${formatted}`);
      }

      if (p.brand) {
        lines.push(`\nBrand:\n${p.brand}`);
      }

      if (p.category || cleanTitle) {
        const cat =
          p.category ||
          cleanTitle.replace(/\s*(collection|catalog|listing|products?)\s*/gi, "").trim();
        if (cat) lines.push(`\nCategory:\n${cat}`);
      }

      const avail = p.availability
        ? p.availability
        : p.in_stock === true
          ? "In Stock"
          : p.in_stock === false
            ? "Out of Stock"
            : "In Stock";
      lines.push(`\nAvailability:\n${avail}`);

      if (p.url) {
        lines.push(`\nProduct URL:\n${p.url}`);
      }
    }
  }

  return stripInlineBufferImageContent(
    lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  );
}

function resolveListingTitle(title, html, pageUrl) {
  let t = cleanText(title || "");
  t = t.replace(/(American Express|Diners Club|Discover|JCB|Maestro|Mastercard|PayPal|Union Pay|Visa)+/gi, "").trim();
  if (t && t !== pageUrl && !/^https?:\/\//i.test(t)) return t;

  if (html) {
    const $ = cheerio.load(html);
    let h1 = cleanText($("h1").first().text());
    h1 = h1.replace(/(American Express|Diners Club|Discover|JCB|Maestro|Mastercard|PayPal|Union Pay|Visa)+/gi, "").trim();
    if (h1 && h1.length < 120) return h1;
    let og = cleanText($('meta[property="og:title"]').attr("content"));
    og = og.replace(/(American Express|Diners Club|Discover|JCB|Maestro|Mastercard|PayPal|Union Pay|Visa)+/gi, "").trim();
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
  const products = [...byKey.values()].slice(0, MAX_PRODUCTS);

  const entity_name = resolveListingTitle(title, html, url);

  const attributes = {
    product_urls: products.map((p) => p.url).filter(Boolean).slice(0, MAX_PRODUCTS),
    product_count: products.length,
    products: products.slice(0, MAX_PRODUCTS),
  };

  const content = listingToMarkdown({
    title: entity_name,
    pageUrl: url,
    products,
    description: metaDescription || "",
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
    products,
    extraction_source: source,
    extraction_confidence: products.length >= 3 ? 0.85 : products.length ? 0.65 : 0.3,
  };
}

module.exports = {
  extractListingContent,
  extractListingFromJsonLd,
  extractListingFromDom,
  listingToMarkdown,
  GRID_SELECTORS,
  CARD_SELECTORS,
  MAX_PRODUCTS,
};
