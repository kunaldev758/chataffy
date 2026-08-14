/**
 * Collect and normalize product variant attrs from JSON-LD, Shopify, and Woo/DOM.
 * Pure helpers — no network. Missing/malformed input returns empty attrs.
 */

const cheerio = require("cheerio");
const { moneyAmountsMatch } = require("./shopifyCurrency");

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function displayStr(value) {
  if (value == null) return "";
  const s = String(value).replace(/\s+/g, " ").trim();
  return s;
}

function normKey(value) {
  return displayStr(value).toLowerCase();
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const display = displayStr(raw);
    if (!display) continue;
    const key = normKey(display);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}

function parseMoney(raw, { shopifyCents = false } = {}) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().replace(/,/g, "");
  const n = Number(s.replace(/[^\d.-]/g, ""));
  // Treat 0 / 0.00 as missing — theme placeholders must not block .json cascade
  if (!Number.isFinite(n) || n <= 0) return null;
  if (shopifyCents && /^\d+$/.test(s) && n >= 100) return n / 100;
  return n;
}

/**
 * Shopify Ajax/theme JSON stores money as integer cents (899 → $8.99).
 * .json storefront endpoint uses dollar strings ("8.99") — those must stay as-is.
 * Returns true when raw values look like cents (no decimals, all integers ≥ 100).
 */
function shopifyRawPricesLookLikeCents(rawPrices = []) {
  const prices = (rawPrices || []).filter((p) => p != null && p !== "");
  if (!prices.length) return false;
  // Dollar strings from /.json always include a decimal for fractional amounts
  if (prices.some((p) => String(p).includes("."))) return false;
  const nums = [];
  for (const p of prices) {
    const s = String(p).trim().replace(/,/g, "");
    if (!/^\d+$/.test(s)) return false;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return false;
    nums.push(n);
  }
  // Align with parseMoney shopifyCents gate (n >= 100)
  return nums.every((n) => n >= 100);
}

/**
 * True when URL/HTML clearly belongs to a Shopify storefront.
 * BigCommerce/Woo/etc. often use integer dollar amounts ("4495" = $4,495) —
 * never treat those as Shopify cents.
 */
function isShopifyStorefront({ url = "", html = "", variantSource = "" } = {}) {
  if (variantSource && /^shopify_/i.test(String(variantSource))) return true;
  const hay = `${url || ""}\n${String(html || "").slice(0, 200000)}`;
  if (
    /cdn\.shopify\.com|myshopify\.com|shopifycloud\.com|\/cdn\/shop\//i.test(hay)
  ) {
    return true;
  }
  if (/#shopify-section-|Shopify\.theme|window\.Shopify\b|Shopify\.shop\b/i.test(hay)) {
    return true;
  }
  if (/\/products\/[^/?#]+/i.test(url || "") && /shopify/i.test(hay)) {
    return true;
  }
  return false;
}

function optionKind(name) {
  const n = normKey(name);
  if (/colou?r|colour|shade|finish/.test(n)) return "color";
  if (/size|waist|length|fit|width/.test(n)) return "size";
  return null;
}

const COLOR_LIKE =
  /^(black|white|red|blue|green|yellow|pink|purple|grey|gray|brown|navy|maroon|beige|orange|silver|gold|ivory|cream|tan|olive|teal|burgundy|charcoal|khaki|coral|mint|lavender|rose|natural|clear|transparent)$/i;

function isColorLike(value) {
  const s = displayStr(value);
  if (!s) return false;
  if (COLOR_LIKE.test(s)) return true;
  // Multi-word color names e.g. "Forest Green", "Matte Black"
  return s.split(/\s+/).some((w) => COLOR_LIKE.test(w));
}

/**
 * Rich = ≥1 variant with a positive price and (color|size|sku).
 * price: 0 must NOT count — otherwise HTML placeholders skip /.json.
 */
function isRichVariantAttrs(attrs) {
  if (!attrs || !Array.isArray(attrs.variants) || !attrs.variants.length) {
    return false;
  }
  return attrs.variants.some(
    (v) =>
      v &&
      v.price != null &&
      Number.isFinite(Number(v.price)) &&
      Number(v.price) > 0 &&
      (v.color || v.size || v.sku),
  );
}

function emptyAttrs() {
  return {
    colors: [],
    sizes: [],
    variants: [],
  };
}

/**
 * Merge attr objects. Arrays union; scalars keep left unless empty.
 */
function unionAttrs(...sources) {
  const out = emptyAttrs();
  let brand = null;
  let sku = null;
  let currency = null;
  let price = null;
  let original_price = null;
  let price_min = null;
  let price_max = null;
  let in_stock = null;

  for (const src of sources) {
    if (!src || typeof src !== "object") continue;

    out.colors = uniqStrings([...out.colors, ...(src.colors || [])]);
    out.sizes = uniqStrings([...out.sizes, ...(src.sizes || [])]);

    if (Array.isArray(src.variants) && src.variants.length) {
      out.variants = [...out.variants, ...src.variants];
    }

    // Singular legacy → arrays
    if (src.color) out.colors = uniqStrings([...out.colors, src.color]);
    if (src.size) out.sizes = uniqStrings([...out.sizes, src.size]);

    if (!brand && src.brand) brand = displayStr(src.brand) || brand;
    if (!sku && src.sku) sku = displayStr(src.sku) || sku;
    if (!currency && src.currency) currency = displayStr(src.currency) || currency;

    if (price == null && src.price != null && Number(src.price) > 0) {
      price = Number(src.price);
    }
    if (
      original_price == null &&
      src.original_price != null &&
      Number(src.original_price) > 0
    ) {
      original_price = Number(src.original_price);
    }
    if (price_min == null && src.price_min != null && Number(src.price_min) > 0) {
      price_min = Number(src.price_min);
    }
    if (price_max == null && src.price_max != null && Number(src.price_max) > 0) {
      price_max = Number(src.price_max);
    }
    if (in_stock == null && src.in_stock != null) in_stock = src.in_stock;
    if (in_stock == null && src.inStock != null) in_stock = src.inStock;
  }

  out.variants = dedupeVariants(out.variants);

  // Derive colors/sizes from variants if still thin
  for (const v of out.variants) {
    if (v.color) out.colors.push(v.color);
    if (v.size) out.sizes.push(v.size);
  }
  out.colors = uniqStrings(out.colors);
  out.sizes = uniqStrings(out.sizes);

  const variantPrices = out.variants
    .map((v) => v.price)
    .filter((p) => p != null && Number.isFinite(p));
  if (variantPrices.length) {
    const vmin = Math.min(...variantPrices);
    const vmax = Math.max(...variantPrices);
    if (price_min == null) price_min = vmin;
    if (price_max == null) price_max = vmax;
    if (price == null) price = vmin;
  }

  if (brand) out.brand = brand;
  if (sku) out.sku = sku;
  if (currency) out.currency = currency;
  if (price != null && !Number.isNaN(price)) out.price = price;
  if (original_price != null && !Number.isNaN(original_price)) {
    out.original_price = original_price;
  }
  if (price_min != null && !Number.isNaN(price_min)) out.price_min = price_min;
  if (price_max != null && !Number.isNaN(price_max)) out.price_max = price_max;
  if (in_stock != null) out.in_stock = in_stock;

  // Back-compat singular mirrors
  if (out.colors[0]) out.color = out.colors[0];
  if (out.sizes[0]) out.size = out.sizes[0];

  return out;
}

function dedupeVariants(variants) {
  const seen = new Set();
  const out = [];
  for (const v of variants || []) {
    if (!v || typeof v !== "object") continue;
    const skuKey = normKey(v.sku);
    const facetKey = `${normKey(v.color)}|${normKey(v.size)}`;
    // Prefer sku identity; else color+size; skip empty shells
    const key = skuKey
      ? `sku:${skuKey}`
      : facetKey !== "|"
        ? `facet:${facetKey}`
        : v.price != null
          ? `price:${v.price}`
          : "";
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.slice(0, 200);
}

function variantFromParts({
  sku,
  color,
  size,
  price,
  currency,
  in_stock,
}) {
  const v = {};
  if (sku) v.sku = displayStr(sku);
  if (color) v.color = displayStr(color);
  if (size) v.size = displayStr(size);
  if (price != null && Number.isFinite(Number(price)) && Number(price) > 0) {
    v.price = Number(price);
  }
  if (currency) v.currency = displayStr(currency);
  if (in_stock != null) v.in_stock = Boolean(in_stock);
  return Object.keys(v).length ? v : null;
}

function walkJsonLd(nodes, visit) {
  const seen = new WeakSet();
  const visitNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    visit(node);
    if (Array.isArray(node)) {
      for (const item of node) visitNode(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "@context") continue;
      if (value && typeof value === "object") visitNode(value);
    }
  };
  for (const node of asArray(nodes)) visitNode(node);
}

function typeList(node) {
  return asArray(node["@type"]).map((t) =>
    String(t || "")
      .toLowerCase()
      .replace(/^https?:\/\/schema\.org\//, "")
      .replace(/^schema\.org\//, "")
      .trim(),
  );
}

function normalizeAvailability(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes("instock") || s.includes("in stock")) return true;
  if (s.includes("outofstock") || s.includes("out of stock")) return false;
  return null;
}

function extractColorSizeFromNode(node) {
  let color =
    node.color ||
    node.colorName ||
    (typeof node.additionalProperty === "object" ? null : null);
  let size = node.size || node.sizeName || null;

  for (const prop of asArray(node.additionalProperty)) {
    if (!prop || typeof prop !== "object") continue;
    const kind = optionKind(prop.name || prop.propertyID);
    const val = prop.value ?? prop.unitText;
    if (kind === "color" && val) color = color || val;
    if (kind === "size" && val) size = size || val;
  }
  return {
    color: color ? displayStr(color) : "",
    size: size ? displayStr(size) : "",
  };
}

/**
 * Collect variants + scalar attrs from JSON-LD Product / Offer / ProductGroup.
 */
function collectFromJsonLd(jsonLdBlocks = []) {
  const variants = [];
  let brand = null;
  let sku = null;
  let currency = null;
  let price = null;
  let in_stock = null;

  walkJsonLd(jsonLdBlocks, (node) => {
    const types = typeList(node);
    const isProduct = types.some((t) =>
      ["product", "productgroup", "individualproduct"].includes(t),
    );
    const isOffer = types.includes("offer") || types.includes("aggregateoffer");
    if (!isProduct && !isOffer) return;

    if (!brand) {
      brand =
        typeof node.brand === "string"
          ? node.brand
          : node.brand?.name || null;
    }

    const offers = isOffer ? [node] : asArray(node.offers);
    const { color, size } = extractColorSizeFromNode(node);
    const nodeSku = node.sku || node.mpn || null;
    if (!sku && nodeSku) sku = nodeSku;

    // Bare Offer nodes without identity — use for scalar price only, not variants
    if (isOffer && !isProduct && !nodeSku && !color && !size) {
      const offerPrice =
        node.price != null
          ? Number(node.price)
          : node.lowPrice != null
            ? Number(node.lowPrice)
            : null;
      if (!currency && node.priceCurrency) currency = node.priceCurrency;
      if (price == null && offerPrice != null && !Number.isNaN(offerPrice)) {
        price = offerPrice;
      }
      const stock = normalizeAvailability(node.availability);
      if (in_stock == null && stock != null) in_stock = stock;
      return;
    }

    if (!offers.length) {
      const v = variantFromParts({
        sku: nodeSku,
        color,
        size,
        price: null,
        in_stock: normalizeAvailability(node.availability),
      });
      if (v && (v.color || v.size || v.sku)) variants.push(v);
      return;
    }

    for (const offer of offers) {
      if (!offer || typeof offer !== "object") continue;
      const offerPrice =
        offer.price != null
          ? Number(offer.price)
          : offer.lowPrice != null
            ? Number(offer.lowPrice)
            : null;
      const offerCur = offer.priceCurrency || null;
      if (!currency && offerCur) currency = offerCur;
      if (price == null && offerPrice != null && !Number.isNaN(offerPrice)) {
        price = offerPrice;
      }
      const stock = normalizeAvailability(
        offer.availability || node.availability,
      );
      if (in_stock == null && stock != null) in_stock = stock;

      const { color: oColor, size: oSize } = extractColorSizeFromNode(offer);
      const v = variantFromParts({
        sku: offer.sku || nodeSku,
        color: oColor || color,
        size: oSize || size,
        price: offerPrice != null && !Number.isNaN(offerPrice) ? offerPrice : null,
        currency: offerCur,
        in_stock: stock,
      });
      if (v && (v.sku || v.color || v.size)) variants.push(v);
    }

    // Explicit hasVariant list
    for (const child of asArray(node.hasVariant)) {
      if (!child || typeof child !== "object") continue;
      const cs = extractColorSizeFromNode(child);
      const childOffers = asArray(child.offers);
      const offer = childOffers[0] && typeof childOffers[0] === "object"
        ? childOffers[0]
        : null;
      const v = variantFromParts({
        sku: child.sku || offer?.sku,
        color: cs.color,
        size: cs.size,
        price:
          offer?.price != null
            ? Number(offer.price)
            : offer?.lowPrice != null
              ? Number(offer.lowPrice)
              : null,
        currency: offer?.priceCurrency,
        in_stock: normalizeAvailability(
          offer?.availability || child.availability,
        ),
      });
      if (v) variants.push(v);
    }
  });

  return unionAttrs({
    brand,
    sku,
    currency,
    price,
    in_stock,
    variants,
  });
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findShopifyProductObject(root, depth = 0) {
  if (!root || typeof root !== "object" || depth > 6) return null;
  if (Array.isArray(root.variants) && root.variants.length) {
    const sample = root.variants[0] || {};
    if (
      Array.isArray(root.options) ||
      root.id ||
      root.handle ||
      sample.option1 != null ||
      sample.price != null ||
      sample.sku
    ) {
      return root;
    }
  }
  if (root.product && typeof root.product === "object") {
    const nested = findShopifyProductObject(root.product, depth + 1);
    if (nested) return nested;
  }
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findShopifyProductObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      const found = findShopifyProductObject(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Pull JSON objects that contain "variants" via brace matching (more reliable than regex).
 */
function extractProductsWithVariantsFromText(text, limit = 4) {
  if (!text || typeof text !== "string") return [];
  const marker = '"variants"';
  const found = [];
  let from = 0;
  while (from < text.length && found.length < limit) {
    const idx = text.indexOf(marker, from);
    if (idx < 0) break;
    let start = idx;
    while (start > 0 && text[start] !== "{") start -= 1;
    if (text[start] !== "{") {
      from = idx + marker.length;
      continue;
    }
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = start; i < Math.min(text.length, start + 500000); i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > start) {
      const parsed = tryParseJson(text.slice(start, end));
      const product = findShopifyProductObject(parsed);
      if (product) found.push(product);
    }
    from = idx + marker.length;
  }
  return found;
}

function mapShopifyVariant(variant, optionNames = [], { pricesInCents = false } = {}) {
  if (!variant || typeof variant !== "object") return null;
  let color = "";
  let size = "";
  const opts = [variant.option1, variant.option2, variant.option3];
  optionNames.forEach((name, i) => {
    const kind = optionKind(name);
    const val = opts[i];
    if (!val) return;
    if (kind === "color") color = displayStr(val);
    else if (kind === "size") size = displayStr(val);
  });

  if (!color && !size) {
    if (variant.option1 && !variant.option2) {
      // Single option: prefer color when value looks like a color
      if (isColorLike(variant.option1)) color = displayStr(variant.option1);
      else size = displayStr(variant.option1);
    } else {
      if (isColorLike(variant.option1) || !isColorLike(variant.option2)) {
        color = displayStr(variant.option1);
        size = displayStr(variant.option2);
      } else {
        size = displayStr(variant.option1);
        color = displayStr(variant.option2);
      }
    }
  }

  // Title-only variants e.g. title: "Black"
  if (!color && !size && variant.title && isColorLike(variant.title)) {
    color = displayStr(variant.title);
  }

  const price = parseMoney(variant.price, { shopifyCents: pricesInCents });
  const original_price = parseMoney(
    variant.compare_at_price ?? variant.compareAtPrice,
    { shopifyCents: pricesInCents },
  );
  const available =
    variant.available != null
      ? Boolean(variant.available)
      : variant.availableForSale != null
        ? Boolean(variant.availableForSale)
        : variant.inventory_quantity != null
          ? Number(variant.inventory_quantity) > 0
          : null;

  const v = variantFromParts({
    sku: variant.sku,
    color,
    size,
    price,
    currency: variant.price_currency || null,
    in_stock: available,
  });
  if (v && original_price != null && original_price > (price ?? 0)) {
    v.original_price = original_price;
  }
  return v;
}

/**
 * Normalize a Shopify product object → canonical attrs.
 */
function attrsFromShopifyProduct(product, { pricesInCents = false } = {}) {
  if (!product || !Array.isArray(product.variants) || !product.variants.length) {
    return emptyAttrs();
  }
  const optionNames = asArray(product.options).map((o) =>
    typeof o === "string" ? o : o?.name || "",
  );
  // Default single unnamed option to Color when all values look like colors
  if (
    (!optionNames.length || !optionNames[0]) &&
    product.variants.every(
      (v) => v?.option1 && !v?.option2 && isColorLike(v.option1),
    )
  ) {
    optionNames[0] = "Color";
  }

  const variants = product.variants
    .map((v) => mapShopifyVariant(v, optionNames, { pricesInCents }))
    .filter(Boolean);

  const comparePrices = product.variants
    .map((v) =>
      parseMoney(v.compare_at_price ?? v.compareAtPrice, { pricesInCents }),
    )
    .filter((p) => p != null);

  return unionAttrs({
    brand:
      typeof product.vendor === "string"
        ? product.vendor
        : product.vendor?.name || null,
    sku: product.variants.find((v) => v?.sku)?.sku || null,
    original_price: comparePrices.length ? Math.max(...comparePrices) : null,
    variants,
  });
}

/**
 * Shopify product JSON embedded in PDP HTML.
 */
function collectFromShopify(html, { url = "" } = {}) {
  if (!html) return emptyAttrs();
  const $ = cheerio.load(html);
  const candidates = [];
  const shopifyPage = isShopifyStorefront({ url, html });

  $('script[type="application/json"], script[type="application/ld+json"]').each(
    (_, el) => {
      const raw = $(el).html() || $(el).text() || "";
      if (!raw || raw.length < 20 || !/variants/i.test(raw)) return;
      const parsed = tryParseJson(raw.trim());
      if (!parsed) return;
      // Skip pure schema.org LD here — handled by collectFromJsonLd
      const types = asArray(parsed["@type"] || parsed["@graph"]);
      if (types.length && !parsed.variants) return;
      const product = findShopifyProductObject(parsed);
      if (product) candidates.push(product);
    },
  );

  if (!candidates.length) {
    for (const product of extractProductsWithVariantsFromText(html, 4)) {
      candidates.push(product);
    }
  }

  // Prefer product with the most priced variants
  let best = null;
  let bestScore = -1;
  for (const product of candidates) {
    const rawPrices = (product.variants || []).flatMap((v) =>
      v ? [v.price, v.compare_at_price ?? v.compareAtPrice] : [],
    );
    // Only treat integers as cents on real Shopify storefronts.
    // BigCommerce JSON-LD "4495" means $4,495 — never /100 there.
    const productLooksShopify =
      shopifyPage ||
      /shopify/i.test(String(product.variants?.[0]?.inventory_management || ""));
    const useCents =
      productLooksShopify && shopifyRawPricesLookLikeCents(rawPrices);
    const normalized = attrsFromShopifyProduct(product, {
      pricesInCents: useCents,
    });
    const score = (normalized.variants || []).filter(
      (v) => v.price != null && Number(v.price) > 0,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = normalized;
    }
  }

  return best || emptyAttrs();
}

function shopifyProductBaseUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    const m = u.pathname.match(/\/products\/([^/?#]+)/i);
    if (!m) return null;
    return `${u.origin}/products/${decodeURIComponent(m[1])}`;
  } catch {
    return null;
  }
}

async function fetchShopifyProductAttrs(baseUrl, ext) {
  const axios = require("axios");
  const https = require("https");
  const endpoint = `${baseUrl}.${ext}`;

  const parseBody = (raw) => {
    let text = raw;
    if (typeof text !== "string") text = JSON.stringify(text);
    text = String(text || "").trim();
    if (text.startsWith("while(1);") || text.startsWith("for(;;);")) {
      text = text.replace(/^while\(1\);|^for\(;;\);/, "");
    }
    const parsed = tryParseJson(text);
    if (!parsed) return emptyAttrs();
    const product =
      findShopifyProductObject(parsed) ||
      (parsed.product && findShopifyProductObject(parsed.product)) ||
      null;
    if (!product) return emptyAttrs();
    return attrsFromShopifyProduct(product, {
      pricesInCents: ext === "js",
    });
  };

  const doGet = async (insecure = false) => {
    const res = await axios.get(endpoint, {
      timeout: Number(process.env.SHOPIFY_VARIANT_FETCH_TIMEOUT_MS) || 5000,
      headers: {
        Accept: "application/json, text/javascript, */*",
        "User-Agent":
          "Mozilla/5.0 (compatible; ChataffyBot/1.0; +https://chataffy.com)",
      },
      validateStatus: (s) => s >= 200 && s < 300,
      responseType: "text",
      transformResponse: [(data) => data],
      maxRedirects: 3,
      ...(insecure
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
    });
    return parseBody(res.data);
  };

  try {
    return await doGet(false);
  } catch (err) {
    const msg = String(err.message || "");
    const isTls =
      /certificate|TLS|SSL|UNABLE_TO_VERIFY/i.test(msg) ||
      err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    if (isTls) {
      try {
        console.warn(
          `[productVariants] Shopify .${ext} TLS retry (insecure) for ${endpoint}`,
        );
        return await doGet(true);
      } catch (err2) {
        console.warn(
          `[productVariants] Shopify .${ext} fetch failed for ${endpoint}: ${err2.message}`,
        );
        return emptyAttrs();
      }
    }
    console.warn(
      `[productVariants] Shopify .${ext} fetch failed for ${endpoint}: ${err.message}`,
    );
    return emptyAttrs();
  }
}

/**
 * WooCommerce data-product_variations + generic option selects.
 */
function collectFromWooDom(html) {
  if (!html) return emptyAttrs();
  const $ = cheerio.load(html);
  const variants = [];
  const colors = [];
  const sizes = [];

  const rawVars =
    $("form.variations_form").attr("data-product_variations") ||
    $("[data-product_variations]").attr("data-product_variations") ||
    "";

  if (rawVars) {
    let decoded = rawVars;
    try {
      decoded = decoded
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
    } catch (_) {
      /* keep */
    }
    const parsed = tryParseJson(decoded);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        let color = "";
        let size = "";
        const attrs = row.attributes || {};
        for (const [key, val] of Object.entries(attrs)) {
          const kind = optionKind(key);
          if (kind === "color") color = displayStr(val);
          else if (kind === "size") size = displayStr(val);
        }
        const price = parseMoney(
          row.display_price ?? row.price ?? row.display_regular_price,
        );
        const v = variantFromParts({
          sku: row.sku,
          color,
          size,
          price,
          in_stock:
            row.is_in_stock != null
              ? Boolean(row.is_in_stock)
              : row.is_purchasable != null
                ? Boolean(row.is_purchasable)
                : null,
        });
        if (v) variants.push(v);
      }
    }
  }

  $("select[name*='attribute'], select[id*='attribute'], select[name*='option']").each(
    (_, el) => {
      const $el = $(el);
      const kind = optionKind(
        $el.attr("name") || $el.attr("id") || $el.attr("data-attribute_name") || "",
      );
      if (!kind) return;
      $el.find("option").each((__, opt) => {
        const val = $(opt).attr("value") || $(opt).text() || "";
        const display = displayStr(val);
        if (!display || /^choose|select|-/i.test(display)) return;
        if (kind === "color") colors.push(display);
        if (kind === "size") sizes.push(display);
      });
    },
  );

  $("[data-value][data-attribute_name], .swatch-attribute, .variant-input").each(
    (_, el) => {
      const $el = $(el);
      const kind = optionKind(
        $el.attr("data-attribute_name") ||
          $el.attr("data-option-name") ||
          $el.attr("aria-label") ||
          "",
      );
      const val =
        $el.attr("data-value") || $el.attr("title") || $el.text();
      const display = displayStr(val);
      if (!kind || !display) return;
      if (kind === "color") colors.push(display);
      if (kind === "size") sizes.push(display);
    },
  );

  return unionAttrs({
    colors,
    sizes,
    variants,
  });
}

function ldFillScalars(ldAttrs) {
  if (!ldAttrs) return {};
  return {
    brand: ldAttrs.brand || null,
    sku: ldAttrs.sku || null,
    currency: ldAttrs.currency || null,
    price: ldAttrs.price,
    original_price: ldAttrs.original_price,
    price_min: ldAttrs.price_min,
    price_max: ldAttrs.price_max,
    in_stock: ldAttrs.in_stock,
  };
}

function fillWithoutMismatchedCurrency(primary, fill) {
  if (!fill) return {};
  if (
    fill.currency &&
    primary &&
    primary.price != null &&
    (fill.price == null || !moneyAmountsMatch(primary.price, fill.price))
  ) {
    const { currency, ...rest } = fill;
    return rest;
  }
  return fill;
}

/**
 * Cascade (prefer unambiguous dollar strings, then cents APIs, then HTML):
 *   .json rich → DONE   (storefront dollars: "8.99")
 *   else .js rich → DONE (Ajax cents: 899; pricesInCents=true)
 *   else HTML rich → DONE (theme embed; cents heuristic)
 *   else JSON-LD + DOM
 *
 * @returns {Promise<{ attrs: object, source: string }>}
 */
async function collectCanonicalProductAttrs({
  html = "",
  jsonLdBlocks = [],
  url = "",
} = {}) {
  const ld = collectFromJsonLd(jsonLdBlocks);
  const dom = collectFromWooDom(html);
  const fromHtml = collectFromShopify(html, { url });
  const fillFor = (primary) => [
    fillWithoutMismatchedCurrency(primary, ldFillScalars(ld)),
    fillWithoutMismatchedCurrency(primary, ldFillScalars(dom)),
  ];

  // 1–2) Shopify product endpoints first (only /products/…)
  // Prefer .json over .js — .json prices are dollars; .js are cents.
  const base = shopifyProductBaseUrl(url);
  if (base) {
    const fromJson = await fetchShopifyProductAttrs(base, "json");
    if (isRichVariantAttrs(fromJson)) {
      return {
        attrs: unionAttrs(fromJson, ...fillFor(fromJson)),
        source: "shopify_json",
      };
    }

    const fromJs = await fetchShopifyProductAttrs(base, "js");
    if (isRichVariantAttrs(fromJs)) {
      return {
        attrs: unionAttrs(fromJs, ...fillFor(fromJs)),
        source: "shopify_js",
      };
    }
  }

  // 3) Embedded HTML (after network — avoids cents-as-dollars when .json works)
  if (isRichVariantAttrs(fromHtml)) {
    return {
      attrs: unionAttrs(fromHtml, ...fillFor(fromHtml)),
      source: "shopify_html",
    };
  }

  // 4) JSON-LD + DOM (+ weak HTML shopify if any)
  return {
    attrs: unionAttrs(ld, fromHtml, dom),
    source: "jsonld_dom",
  };
}

/**
 * Sync helper for tests / non-network path (HTML + LD + DOM only).
 */
function collectCanonicalProductAttrsSync({
  html = "",
  jsonLdBlocks = [],
  url = "",
} = {}) {
  return unionAttrs(
    collectFromJsonLd(jsonLdBlocks),
    collectFromShopify(html, { url }),
    collectFromWooDom(html),
  );
}

/**
 * Extra sparse/search tokens from product attrs.
 */
function termsFromProductAttrs(attrs = {}, entityName = "") {
  const terms = [];
  if (entityName) terms.push(entityName);
  if (attrs.brand) terms.push(attrs.brand);
  if (attrs.sku) terms.push(attrs.sku);
  for (const c of attrs.colors || []) terms.push(c);
  for (const s of attrs.sizes || []) terms.push(s);
  for (const v of attrs.variants || []) {
    if (v.sku) terms.push(v.sku);
    if (v.color) terms.push(v.color);
    if (v.size) terms.push(v.size);
  }
  return uniqStrings(terms).slice(0, 40);
}

/**
 * Short embed/context line from attrs (free summary piece).
 */
function formatAttrContextLine(attrs = {}) {
  const parts = [];
  if (attrs.brand) parts.push(`Brand: ${attrs.brand}`);
  if (attrs.colors?.length) parts.push(`Colors: ${attrs.colors.join(", ")}`);
  if (attrs.sizes?.length) parts.push(`Sizes: ${attrs.sizes.join(", ")}`);
  if (attrs.sku) parts.push(`SKU: ${attrs.sku}`);
  if (attrs.price != null) {
    const cur = attrs.currency ? ` ${attrs.currency}` : "";
    parts.push(`Price: ${attrs.price}${cur}`);
  } else if (attrs.price_min != null && attrs.price_max != null) {
    parts.push(`Price: ${attrs.price_min}–${attrs.price_max}`);
  }
  return parts.length ? parts.join(" | ") : "";
}

function mergeStringLists(...lists) {
  return uniqStrings(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
}

module.exports = {
  unionAttrs,
  collectCanonicalProductAttrs,
  collectCanonicalProductAttrsSync,
  collectFromJsonLd,
  collectFromShopify,
  collectFromWooDom,
  attrsFromShopifyProduct,
  isRichVariantAttrs,
  shopifyProductBaseUrl,
  shopifyRawPricesLookLikeCents,
  isShopifyStorefront,
  termsFromProductAttrs,
  formatAttrContextLine,
  mergeStringLists,
  uniqStrings,
  parseMoney,
};
