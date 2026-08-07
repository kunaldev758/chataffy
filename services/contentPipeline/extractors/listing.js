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
    const price_min =
      offer?.lowPrice != null ? Number(offer.lowPrice) : null;
    const price_max =
      offer?.highPrice != null ? Number(offer.highPrice) : null;
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
    if (
      price_min != null &&
      price_max != null &&
      !Number.isNaN(price_min) &&
      !Number.isNaN(price_max) &&
      price_min !== price_max
    ) {
      row.price_min = price_min;
      row.price_max = price_max;
      if (row.price == null) row.price = price_min;
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

function parseAllPrices(text) {
  const cleaned = String(text || "").replace(/,/g, "");
  const nums = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const n = Number(match[1]);
    if (!Number.isNaN(n) && n > 0) nums.push(n);
  }
  return nums;
}

/** Prices must include a currency marker — never treat "25′" in a title as $25. */
function extractCurrencyPrices(text) {
  const str = String(text || "");
  const results = [];
  const re =
    /(?:([$€£¥₹₩]|Rs\.?|USD|EUR|GBP|INR)\s*)([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(USD|EUR|GBP|INR)\b/gi;
  let match;
  while ((match = re.exec(str)) !== null) {
    const raw = match[2] || match[3];
    const curTok = match[1] || match[4] || "";
    const num = parsePrice(raw);
    if (num == null || num <= 0) continue;
    results.push({
      amount: num,
      currency: extractCurrencySymbol(curTok || str) || "$",
      index: match.index,
    });
  }
  return results;
}

function extractPriceRange(text) {
  const normalized = String(text || "").replace(/,/g, "");
  const rangeMatch = normalized.match(
    /([$€£¥₹]|Rs\.?)\s*(\d+(?:\.\d+)?)\s*(?:[\u2013\u2014\-]|(?:\s+to\s+))\s*(?:([$€£¥₹]|Rs\.?)\s*)?(\d+(?:\.\d+)?)/i,
  );
  if (!rangeMatch) return null;
  const min = Number(rangeMatch[2]);
  const max = Number(rangeMatch[4]);
  if (Number.isNaN(min) || Number.isNaN(max) || min === max) return null;
  if (Math.max(min, max) < 5 && !/\.\d{2}\b/.test(normalized)) return null;
  return {
    price_min: Math.min(min, max),
    price_max: Math.max(min, max),
    currency: extractCurrencySymbol(rangeMatch[1] || text) || "$",
  };
}

function formatListingPrice(amount, currency) {
  if (amount == null) return null;
  const cur = currency ? String(currency).trim() : "$";
  if (/^[$€£₹¥₩₪฿₫₱]/i.test(cur)) return `${cur}${amount}`;
  return `${amount} ${cur}`;
}

/**
 * Extract current, original (compare-at), and range prices from a product card.
 * Prefer sale / <ins> / "Now:" amounts — never bare title numbers (25′, 35').
 */
function extractPriceFromCard($, $el) {
  const out = {
    price: null,
    original_price: null,
    price_min: null,
    price_max: null,
    currency: "",
  };

  const applyRange = (text) => {
    const range = extractPriceRange(text);
    if (!range) return false;
    out.price_min = range.price_min;
    out.price_max = range.price_max;
    out.price = range.price_min;
    out.currency = range.currency || out.currency;
    return true;
  };

  // 0. WooCommerce: <del>MRP</del> <ins>sale</ins>
  const $ins = $el
    .find("ins .woocommerce-Price-amount, ins .amount, p.price ins, .price ins")
    .first();
  const $del = $el
    .find("del .woocommerce-Price-amount, del .amount, p.price del, .price del")
    .first();
  if ($ins.length) {
    const priced = extractCurrencyPrices(cleanText($ins.text()));
    if (priced.length) {
      out.price = priced[0].amount;
      out.currency = priced[0].currency;
    }
  }
  if ($del.length) {
    const priced = extractCurrencyPrices(cleanText($del.text()));
    if (priced.length) {
      out.original_price = priced[0].amount;
      out.currency = priced[0].currency || out.currency;
    }
  }
  if (out.price == null) {
    const currentHint = cleanText($el.text()).match(
      /Current price is:\s*([₹$€£]|Rs\.?)?\s*([\d,]+(?:\.\d+)?)/i,
    );
    if (currentHint) {
      const n = parsePrice(currentHint[2]);
      if (n != null) {
        out.price = n;
        out.currency =
          extractCurrencySymbol(currentHint[1] || "") || out.currency || "₹";
      }
    }
  }
  if (out.original_price == null) {
    const wasHint = cleanText($el.text()).match(
      /Original price was:\s*([₹$€£]|Rs\.?)?\s*([\d,]+(?:\.\d+)?)/i,
    );
    if (wasHint) {
      const n = parsePrice(wasHint[2]);
      if (n != null) {
        out.original_price = n;
        out.currency =
          extractCurrencySymbol(wasHint[1] || "") || out.currency || "₹";
      }
    }
  }

  // 1. BigCommerce / Shopify current-price nodes
  if (out.price == null) {
    const nowSelectors = [
      ".price--withoutTax",
      ".price--withTax",
      "[data-product-price-without-tax]",
      "[data-product-price]",
      ".price-item--sale",
      ".price--sale",
      ".sale-price",
      ".sale_price",
      ".price__sale",
      "[itemprop='price']",
      ".price-section--withoutTax .price",
    ].join(", ");

    for (const el of $el.find(nowSelectors).toArray()) {
      const $node = $(el);
      const cls = `${$node.attr("class") || ""}`;
      if (/price--rrp|price--non-sale|non-sale-price|rrp-price/i.test(cls)) continue;
      if ($node.closest("del, s, strike").length) continue;
      const text = cleanText(
        $node.attr("content") ||
          $node.attr("data-product-price-without-tax") ||
          $node.text(),
      );
      if (!text || !/\d/.test(text)) continue;
      if (applyRange(text)) break;
      const priced = extractCurrencyPrices(text);
      if (priced.length) {
        out.price = priced[0].amount;
        out.currency = priced[0].currency;
        break;
      }
    }
  }

  // 2. Compare-at / Was price
  if (out.original_price == null) {
    const compareSelectors = [
      ".price--non-sale",
      ".price--rrp",
      ".price-item--regular",
      ".compare-at-price",
      ".compare_at_price",
      ".price--compare",
      ".price__regular",
      ".was-price",
      "[class*='compare-at' i]",
      "del",
      "s",
      "strike",
    ].join(", ");

    for (const el of $el.find(compareSelectors).toArray()) {
      const text = cleanText($(el).text());
      const priced = extractCurrencyPrices(text);
      if (priced.length) {
        out.original_price = priced[0].amount;
        out.currency = priced[0].currency || out.currency;
        break;
      }
    }
  }

  // 3. BigCommerce "Now:" sections
  if (out.price == null || out.price_min == null) {
    for (const el of $el.find(".price-section, [class*='price-section' i]").toArray()) {
      const text = cleanText($(el).text());
      if (!/now\s*:/i.test(text) && !extractCurrencyPrices(text).length) continue;
      if (out.price_min == null && applyRange(text)) continue;
      if (out.price == null) {
        const priced = extractCurrencyPrices(text);
        if (priced.length) {
          out.price = priced[0].amount;
          out.currency = priced[0].currency;
        }
      }
    }
  }

  // 4. Fallback: currency amounts in .price node (min = sale, max = original)
  if (out.price == null || out.original_price == null || out.price_min == null) {
    const priceNodeText = cleanText($el.find("p.price, span.price, .price").first().text());
    const fullText = priceNodeText || cleanText($el.text());
    if (out.price_min == null && priceNodeText) applyRange(priceNodeText);
    const priced = extractCurrencyPrices(fullText);
    if (priced.length >= 2) {
      const amounts = priced.map((p) => p.amount);
      const min = Math.min(...amounts);
      const max = Math.max(...amounts);
      if (out.price == null || (out.price > min && max > min)) {
        out.price = min;
        out.currency = priced[0].currency || out.currency;
      }
      if (out.original_price == null && max > (out.price || min)) {
        out.original_price = max;
      }
    } else if (out.price == null && priced.length) {
      out.price = priced[0].amount;
      out.currency = priced[0].currency;
    }
  }

  if (
    out.original_price != null &&
    out.price != null &&
    out.original_price <= out.price
  ) {
    out.original_price = null;
  }

  if (out.price != null && out.price_min == null) {
    const nameHint = cleanText(
      $el.find("h2, h3, h4, h5, .card-title, [class*='title' i], a").first().text() ||
        $el.find("img[alt]").attr("alt") ||
        "",
    );
    const dim = nameHint.match(/(\d+)\s*['′']/);
    if (dim && Number(dim[1]) === out.price && out.price < 100) {
      out.price = null;
    }
  }

  if (!out.currency && out.price != null) out.currency = "$";
  return out;
}


function detectCardAvailability($, $el) {
  const text = cleanText($el.text()).toLowerCase();
  if (
    /sold\s*out|out\s*of\s*stock|unavailable|notify\s*me\s*when\s*available/.test(
      text,
    )
  ) {
    return false;
  }
  if ($el.find("[class*='sold-out' i], [class*='soldout' i], .badge--sold-out").length) {
    return false;
  }
  if (/in\s*stock|add\s*to\s*cart|buy\s*now/.test(text)) return true;
  return null;
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

  const { price, original_price, price_min, price_max, currency } =
    extractPriceFromCard($, $el);
  const in_stock = detectCardAvailability($, $el);

  if (!name && !url) return null;
  // Exclude account/login/cart/nav links
  if (url && /\/(account|login|register|cart|checkout|policies|blogs|search|wishlist)(\/|$|\?)/i.test(url)) {
    return null;
  }
  // Exclude non-product URLs (CDN images, social share, captcha, claims)
  if (
    url &&
    (/\/cdn\/shop\//i.test(url) ||
      /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(url) ||
      /facebook\.com\/sharer|twitter\.com\/intent|pinterest\.com\/pin/i.test(url) ||
      /hcaptcha\.com|claims\.route\.com/i.test(url))
  ) {
    return null;
  }
  if (
    name &&
    /^(log in|sign in|account|cart|checkout|search|view all|privacy|terms|menu|close|filter|sort|collections?|shipping|shipping policy|returns?|returns policy|package protection|customer reviews|ask a question|share)$/i.test(
      name.trim(),
    )
  ) {
    return null;
  }

  const row = { name: name || null, url: url || null };
  if (price != null && !Number.isNaN(price)) {
    row.price = price;
    if (currency) row.currency = currency;
  }
  if (original_price != null && !Number.isNaN(original_price)) {
    row.original_price = original_price;
    if (currency) row.currency = currency;
  }
  if (price_min != null && price_max != null && price_min !== price_max) {
    row.price_min = price_min;
    row.price_max = price_max;
    if (currency) row.currency = currency;
  }
  if (in_stock != null) row.in_stock = in_stock;
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
    if (
      row.url &&
      (/\/cdn\/shop\//i.test(row.url) ||
        /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(row.url) ||
        /facebook\.com\/sharer|twitter\.com\/intent|pinterest\.com\/pin/i.test(row.url) ||
        /hcaptcha\.com|claims\.route\.com/i.test(row.url))
    ) {
      return;
    }
    if (
      row.name &&
      /^(log in|sign in|account|cart|checkout|search|view all|privacy|terms|menu|close|filter|sort|collections?|shipping|shipping policy|returns?|returns policy|package protection|customer reviews|ask a question|share)$/i.test(
        row.name.trim(),
      )
    ) {
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
      const { price, original_price, price_min, price_max, currency } =
        extractPriceFromCard($, $card);
      const in_stock = detectCardAvailability($, $card);
      const row = { name: name || null, url };
      if (price != null) {
        row.price = price;
        if (currency) row.currency = currency;
      }
      if (original_price != null) row.original_price = original_price;
      if (price_min != null && price_max != null && price_min !== price_max) {
        row.price_min = price_min;
        row.price_max = price_max;
      }
      if (in_stock != null) row.in_stock = in_stock;
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

      if (
        p.original_price != null &&
        p.price != null &&
        p.original_price !== p.price
      ) {
        const cur = p.currency || "$";
        // "Price" = current selling amount (what the bot should answer with)
        lines.push(`\nPrice:\n${formatListingPrice(p.price, cur)}`);
        lines.push(
          `\nOriginal price:\n${formatListingPrice(p.original_price, cur)}`,
        );
      } else if (
        p.price_min != null &&
        p.price_max != null &&
        p.price_min !== p.price_max
      ) {
        const cur = p.currency || "$";
        lines.push(
          `\nPrice:\n${formatListingPrice(p.price_min, cur)} – ${formatListingPrice(p.price_max, cur)}`,
        );
      } else if (p.price != null) {
        const cur = p.currency ? p.currency : "$";
        lines.push(`\nPrice:\n${formatListingPrice(p.price, cur)}`);
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

  // Merge: prefer richer DOM price fields when JSON-LD only has a single price
  const byKey = new Map();
  for (const p of [...fromLd, ...fromDom]) {
    const key = (p.url || p.name || "").toLowerCase();
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { ...p });
    } else {
      const prev = byKey.get(key);
      const merged = {
        name: prev.name || p.name,
        url: prev.url || p.url,
        price: prev.price != null ? prev.price : p.price,
        currency: prev.currency || p.currency,
        brand: prev.brand || p.brand,
        category: prev.category || p.category,
        availability: prev.availability || p.availability,
        in_stock:
          prev.in_stock != null
            ? prev.in_stock
            : p.in_stock != null
              ? p.in_stock
              : null,
        original_price:
          prev.original_price != null ? prev.original_price : p.original_price,
        price_min: prev.price_min != null ? prev.price_min : p.price_min,
        price_max: prev.price_max != null ? prev.price_max : p.price_max,
      };

      // If DOM has sale + original and LD price equals the compare-at, use sale
      if (
        p.price != null &&
        p.original_price != null &&
        (prev.original_price == null || prev.price === p.original_price)
      ) {
        merged.price = p.price;
        merged.original_price = p.original_price;
        if (p.currency) merged.currency = p.currency;
      }
      // Prefer DOM range / real currency prices over title-dimension false positives
      if (
        p.price_min != null &&
        p.price_max != null &&
        (prev.price_min == null || prev.price_max == null)
      ) {
        merged.price_min = p.price_min;
        merged.price_max = p.price_max;
        merged.price = p.price != null ? p.price : p.price_min;
        if (p.currency) merged.currency = p.currency;
      } else if (
        p.price != null &&
        (prev.price == null ||
          (prev.price < 100 && p.price >= 100) ||
          (p.price_min != null && prev.price_min == null))
      ) {
        merged.price = p.price;
        if (p.currency) merged.currency = p.currency;
        if (p.original_price != null) merged.original_price = p.original_price;
        if (p.price_min != null) merged.price_min = p.price_min;
        if (p.price_max != null) merged.price_max = p.price_max;
      }
      if (p.in_stock === false) merged.in_stock = false;

      for (const k of Object.keys(merged)) {
        if (merged[k] == null) delete merged[k];
      }
      byKey.set(key, merged);
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
