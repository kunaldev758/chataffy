const cheerio = require("cheerio");
const {
  stripInlineBufferImageContent,
  extractCleanProductBody,
} = require("../htmlCleanup");

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
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

function pickOffer(node) {
  const offers = asArray(node.offers);
  if (!offers.length) return null;
  return typeof offers[0] === "object" ? offers[0] : { price: offers[0] };
}

function parsePrice(text) {
  const m = String(text || "")
    .replace(/,/g, "")
    .match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function parseAllPrices(text) {
  const cleaned = String(text || "").replace(/,/g, "");
  const nums = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    nums.push(Number(match[1]));
  }
  return nums;
}

function extractCurrencySymbol(text = "") {
  const str = String(text || "").trim();
  if (/₹|rs\.?|inr/i.test(str)) return "₹";
  if (/€|eur/i.test(str)) return "€";
  if (/£|gbp/i.test(str)) return "£";
  if (/\$|usd|cad|aud/i.test(str)) return "$";
  if (/¥|jpy|cny/i.test(str)) return "¥";
  if (/₩|krw/i.test(str)) return "₩";
  return "";
}

const SALE_PRICE_SELECTORS = [
  ".price--withoutTax",
  ".price--withTax",
  "[data-product-price-without-tax]",
  "[data-product-price]",
  "[itemprop='price']",
  ".price-item--sale",
  ".price--sale",
  ".sale-price",
  ".sale_price",
  ".price__sale",
  ".product-price__amount--final",
  "[class*='sale-price']",
  "[class*='price--sale']",
].join(", ");

const COMPARE_PRICE_SELECTORS = [
  ".price--non-sale",
  ".price--rrp",
  ".price-item--regular",
  ".compare-at-price",
  ".compare_at_price",
  ".price--compare",
  ".price__regular",
  ".was-price",
  "[class*='compare-at']",
  "del",
  "s",
  "strike",
  "[class*='price--regular']",
].join(", ");

const PRICE_ROOT_SELECTORS = [
  ".productView-price",
  ".product-price",
  ".price-section",
  ".product__info-wrapper",
  ".product-info",
  ".product-single__meta",
  ".product__price",
  ".price-wrapper",
  "[class*='product__price']",
  ".price",
].join(", ");

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
    });
  }
  return results;
}

function extractPriceRange(text) {
  const normalized = String(text || "").replace(/,/g, "");
  // Require a currency marker on the first amount so "1–3 business days" never matches
  const rangeMatch = normalized.match(
    /([$€£¥₹]|Rs\.?)\s*(\d+(?:\.\d+)?)\s*(?:[\u2013\u2014\-]|(?:\s+to\s+))\s*(?:([$€£¥₹]|Rs\.?)\s*)?(\d+(?:\.\d+)?)/i,
  );
  if (!rangeMatch) return null;
  const min = Number(rangeMatch[2]);
  const max = Number(rangeMatch[4]);
  if (Number.isNaN(min) || Number.isNaN(max) || min === max) return null;
  // Ignore tiny non-money spans (shipping days, ratings, etc.)
  if (Math.max(min, max) < 5 && !/\.\d{2}\b/.test(normalized)) return null;
  return {
    price_min: Math.min(min, max),
    price_max: Math.max(min, max),
    currency: extractCurrencySymbol(rangeMatch[1] || text) || "$",
  };
}

function extractPriceFromOffer(offer) {
  if (!offer || typeof offer !== "object") return {};
  const out = {};
  if (offer.price != null) {
    const p = Number(offer.price);
    if (!Number.isNaN(p)) out.price = p;
  }
  if (offer.lowPrice != null) {
    const p = Number(offer.lowPrice);
    if (!Number.isNaN(p)) out.price_min = p;
  }
  if (offer.highPrice != null) {
    const p = Number(offer.highPrice);
    if (!Number.isNaN(p)) out.price_max = p;
  }
  if (offer.priceCurrency) out.currency = offer.priceCurrency;
  if (out.price == null && out.price_min != null) out.price = out.price_min;
  return out;
}

/**
 * Parse sale, compare-at, and range prices from product DOM (Shopify, WooCommerce, etc.).
 */
function extractProductPricesFromDom(html) {
  const $ = cheerio.load(html || "");
  const $root = $(PRICE_ROOT_SELECTORS).first();
  const scope = $root.length ? $root : $("body");
  const attrs = {};
  let currency = "";

  const applyRange = (text) => {
    const range = extractPriceRange(text);
    if (!range) return false;
    attrs.price_min = range.price_min;
    attrs.price_max = range.price_max;
    if (attrs.price == null) attrs.price = range.price_min;
    currency = range.currency || currency;
    return true;
  };

  // WooCommerce: <del>MRP</del> <ins>sale</ins>
  const $ins = scope
    .find("ins .woocommerce-Price-amount, p.price ins, .summary ins")
    .first();
  const $del = scope
    .find("del .woocommerce-Price-amount, p.price del, .summary del")
    .first();
  if ($ins.length) {
    const priced = extractCurrencyPrices(
      String($ins.text() || "").replace(/\s+/g, " ").trim(),
    );
    if (priced.length) {
      attrs.price = priced[0].amount;
      currency = priced[0].currency || currency;
    }
  }
  if ($del.length) {
    const priced = extractCurrencyPrices(
      String($del.text() || "").replace(/\s+/g, " ").trim(),
    );
    if (priced.length) {
      attrs.original_price = priced[0].amount;
      currency = priced[0].currency || currency;
    }
  }

  const itempropPrice = scope.find("[itemprop='price']").attr("content");
  if (itempropPrice) {
    const p = parsePrice(itempropPrice);
    if (p != null) {
      // Don't let schema MRP overwrite a lower WooCommerce <ins> sale price
      if (attrs.price == null || p < attrs.price) attrs.price = p;
      currency = extractCurrencySymbol(itempropPrice) || currency;
    }
  }

  if (attrs.price == null || attrs.price_min == null) {
    for (const el of scope.find(SALE_PRICE_SELECTORS).toArray()) {
      const $node = $(el);
      const cls = `${$node.attr("class") || ""}`;
      if (/price--rrp|price--non-sale|non-sale-price|rrp-price/i.test(cls)) continue;
      const raw = String(
        $node.attr("content") ||
          $node.attr("data-product-price-without-tax") ||
          $node.text() ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!raw || !/\d/.test(raw)) continue;
      if (attrs.price_min == null && applyRange(raw)) {
        if (attrs.price == null) attrs.price = attrs.price_min;
        break;
      }
      const priced = extractCurrencyPrices(raw);
      if (priced.length && attrs.price == null) {
        attrs.price = priced[0].amount;
        currency = priced[0].currency || currency;
        break;
      }
    }
  }

  for (const el of scope.find(COMPARE_PRICE_SELECTORS).toArray()) {
    const raw = String($(el).text() || "").replace(/\s+/g, " ").trim();
    const priced = extractCurrencyPrices(raw);
    if (priced.length) {
      attrs.original_price = priced[0].amount;
      currency = priced[0].currency || currency;
      break;
    }
  }

  // Prefer explicit price nodes / "Now:" sections over first generic [class*=price]
  if (attrs.price == null || attrs.price_min == null) {
    const candidates = [];
    scope
      .find(
        ".price--withoutTax, .price-item--sale, .price-item--regular, .price-section, [class*='price' i]",
      )
      .each((_, el) => {
        const t = String($(el).text() || "").replace(/\s+/g, " ").trim();
        if (
          t &&
          /\d/.test(t) &&
          (/[$€£¥₹]|Rs\.?/i.test(t) || /now\s*:/i.test(t))
        ) {
          candidates.push(t);
        }
      });

    // Only search for ranges in compact price snippets (not full page / shipping copy)
    if (attrs.price_min == null) {
      for (const block of candidates) {
        if (block.length > 80) continue;
        if (applyRange(block)) break;
      }
    }

    if (attrs.price == null) {
      for (const block of candidates) {
        const priced = extractCurrencyPrices(block);
        if (priced.length >= 2) {
          const amounts = priced.map((p) => p.amount);
          const min = Math.min(...amounts);
          const max = Math.max(...amounts);
          attrs.price = min;
          if (max > min) attrs.original_price = max;
          currency = priced[0].currency || currency;
          break;
        }
        if (priced.length) {
          attrs.price = priced[0].amount;
          currency = priced[0].currency || currency;
          break;
        }
      }
    }
  }

  // If we have a sale price but missed compare-at, recover from multi-price snippets
  if (attrs.price != null && attrs.original_price == null) {
    const priced = extractCurrencyPrices(
      String(
        scope.find(".price, [class*='price' i]").text() || "",
      ).replace(/\s+/g, " "),
    );
    if (priced.length >= 2) {
      const max = Math.max(...priced.map((p) => p.amount));
      if (max > attrs.price) attrs.original_price = max;
    }
  }

  // Drop bogus ranges that conflict with a real selling price
  if (
    attrs.price != null &&
    attrs.price_min != null &&
    attrs.price_max != null &&
    (attrs.price_max < 5 ||
      (attrs.price > attrs.price_max && attrs.price > attrs.price_min))
  ) {
    delete attrs.price_min;
    delete attrs.price_max;
  }

  if (
    attrs.original_price != null &&
    attrs.price != null &&
    attrs.original_price <= attrs.price
  ) {
    delete attrs.original_price;
  }

  if (currency) attrs.currency = currency;

  for (const k of Object.keys(attrs)) {
    if (typeof attrs[k] === "number" && Number.isNaN(attrs[k])) delete attrs[k];
  }

  return attrs;
}

function mergePriceAttributes(ldAttrs = {}, domAttrs = {}) {
  const merged = {};
  if (ldAttrs.currency) merged.currency = ldAttrs.currency;
  else if (domAttrs.currency) merged.currency = domAttrs.currency;

  // Prefer DOM selling price when it looks like a real discount vs LD/compare-at
  merged.price = domAttrs.price ?? ldAttrs.price ?? null;
  if (
    ldAttrs.price != null &&
    domAttrs.price != null &&
    domAttrs.original_price != null &&
    ldAttrs.price === domAttrs.original_price
  ) {
    merged.price = domAttrs.price;
  } else if (
    ldAttrs.price != null &&
    (domAttrs.price == null ||
      (domAttrs.original_price == null && ldAttrs.price < domAttrs.price))
  ) {
    // LD often has the live offer price — keep the lower credible amount
    if (domAttrs.price == null) merged.price = ldAttrs.price;
    else merged.price = Math.min(ldAttrs.price, domAttrs.price);
  }

  const domRangeOk =
    domAttrs.price_min != null &&
    domAttrs.price_max != null &&
    Math.max(domAttrs.price_min, domAttrs.price_max) >= 5;
  const ldRangeOk =
    ldAttrs.price_min != null &&
    ldAttrs.price_max != null &&
    Math.max(ldAttrs.price_min, ldAttrs.price_max) >= 5;

  merged.price_min = domRangeOk
    ? domAttrs.price_min
    : ldRangeOk
      ? ldAttrs.price_min
      : null;
  merged.price_max = domRangeOk
    ? domAttrs.price_max
    : ldRangeOk
      ? ldAttrs.price_max
      : null;
  merged.original_price = domAttrs.original_price ?? null;

  if (
    merged.price != null &&
    merged.original_price == null &&
    ldAttrs.price != null &&
    ldAttrs.price > merged.price
  ) {
    merged.original_price = ldAttrs.price;
  }

  if (merged.price == null && merged.price_min != null) {
    merged.price = merged.price_min;
  }

  for (const k of Object.keys(merged)) {
    if (merged[k] == null || Number.isNaN(merged[k])) delete merged[k];
  }
  return merged;
}

function formatPriceValue(amount, currency) {
  if (amount == null) return null;
  let cur = currency ? String(currency).trim() : "";
  const codeMap = {
    INR: "₹",
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    CNY: "¥",
    AUD: "$",
    CAD: "$",
  };
  if (codeMap[cur.toUpperCase()]) cur = codeMap[cur.toUpperCase()];
  if (/^[$€£₹¥₩]/i.test(cur)) return `${cur}${amount}`;
  if (cur) return `${amount} ${cur}`;
  return String(amount);
}

function normalizeAvailability(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes("instock") || s.includes("in stock")) return true;
  if (s.includes("outofstock") || s.includes("out of stock")) return false;
  return null;
}

/**
 * Extract Product / Offer fields from JSON-LD blocks.
 * Merges nested ProductGroup → hasVariant → Offer so price/SKU are not dropped.
 */
function extractProductFromJsonLd(jsonLdBlocks = []) {
  let best = null;

  const attrRichness = (attrs = {}) => Object.keys(attrs).length;

  walkJsonLd(jsonLdBlocks, (node) => {
    const types = typeList(node);
    const isVariantProduct = types.includes("product");
    const isGroup = types.includes("productgroup");
    const isProduct = types.some((t) =>
      ["product", "productgroup", "individualproduct"].includes(t),
    );
    if (!isProduct && !types.includes("offer")) return;

    const offer = pickOffer(node) || (types.includes("offer") ? node : null);
    const name =
      node.name ||
      node.title ||
      (typeof node.headline === "string" ? node.headline : null);
    const description =
      typeof node.description === "string" ? node.description : "";

    const attrs = {
      sku: node.sku || node.mpn || offer?.sku || null,
      brand:
        typeof node.brand === "string"
          ? node.brand
          : node.brand?.name || null,
      ...extractPriceFromOffer(offer),
      in_stock: normalizeAvailability(
        offer?.availability || node.availability,
      ),
      color: node.color || null,
      size: node.size || null,
    };

    for (const k of Object.keys(attrs)) {
      if (attrs[k] == null || Number.isNaN(attrs[k])) delete attrs[k];
    }

    // Prefer concrete Product/Offer over ProductGroup shell
    let confidence = 0.6;
    if (isVariantProduct || types.includes("individualproduct")) confidence = 0.95;
    else if (isGroup) confidence = 0.88;
    else if (isProduct) confidence = 0.92;
    else if (types.includes("offer")) confidence = 0.7;

    const candidate = {
      entity_name: name || null,
      description,
      attributes: attrs,
      confidence,
      source: "json_ld",
    };

    if (!best) {
      best = candidate;
      return;
    }

    // Merge attributes into best (fill missing keys from any product/offer node)
    for (const [k, v] of Object.entries(attrs)) {
      if (best.attributes[k] == null && v != null) {
        best.attributes[k] = v;
      }
    }
    if (!best.description && description) best.description = description;
    if (
      candidate.confidence > best.confidence ||
      (candidate.confidence === best.confidence &&
        attrRichness(attrs) > attrRichness(best.attributes))
    ) {
      best = {
        ...candidate,
        attributes: { ...attrs, ...best.attributes, ...attrs },
        description: candidate.description || best.description,
        entity_name: candidate.entity_name || best.entity_name,
      };
    } else if (!best.entity_name && candidate.entity_name) {
      best.entity_name = candidate.entity_name;
    }
  });

  return best;
}

/**
 * Weaker DOM heuristics when JSON-LD is missing.
 */
function extractProductFromDom(html, url) {
  const $ = cheerio.load(html || "");
  const name =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $('[itemprop="name"]').first().text().trim() ||
    null;

  const description =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    $('[itemprop="description"]').first().text().trim() ||
    "";

  const sku =
    $('[itemprop="sku"]').attr("content") ||
    $('[itemprop="sku"]').first().text().trim() ||
    null;

  const priceAttrs = extractProductPricesFromDom(html);

  const attrs = { ...priceAttrs };
  if (sku) attrs.sku = sku.trim();

  const inStockText = $(".stock, .availability, [class*='stock']")
    .first()
    .text()
    .toLowerCase();
  if (inStockText.includes("in stock")) attrs.in_stock = true;
  if (inStockText.includes("out of stock")) attrs.in_stock = false;

  if (!name && !description && Object.keys(attrs).length === 0) {
    return null;
  }

  return {
    entity_name: name,
    description,
    attributes: attrs,
    confidence: 0.45,
    source: "dom_heuristic",
  };
}

function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[#*_`>\-\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when short LD/meta description is already covered by the cleaned body.
 */
function descriptionCoveredByBody(shortDesc, bodyMarkdown) {
  const shortNorm = normalizeForCompare(shortDesc);
  const bodyNorm = normalizeForCompare(bodyMarkdown);
  if (!shortNorm || shortNorm.length < 20) return true;
  if (!bodyNorm) return false;
  if (bodyNorm.includes(shortNorm)) return true;
  // Prefix match for truncated meta descriptions
  const prefix = shortNorm.slice(0, Math.min(80, shortNorm.length));
  return prefix.length >= 20 && bodyNorm.includes(prefix);
}

/**
 * Build structured shell. Optionally omit short ## Description when body will cover it.
 */
function productToMarkdown({
  entity_name,
  description,
  attributes,
  url,
  includeShortDescription = true,
}) {
  const lines = [];
  if (entity_name) lines.push(`# ${entity_name}`);
  if (url) lines.push(`\nProduct URL:\n${url}`);

  const attrLines = [];
  if (attributes?.sku) attrLines.push(`- SKU: ${attributes.sku}`);
  if (attributes?.brand) attrLines.push(`- Brand: ${attributes.brand}`);

  const cur = attributes?.currency || "";
  // Always expose current selling price as "Price" so chat answers prefer it
  // over compare-at / Was amounts in the page body.
  if (
    attributes?.original_price != null &&
    attributes?.price != null &&
    attributes.original_price !== attributes.price
  ) {
    attrLines.push(`- Price: ${formatPriceValue(attributes.price, cur)}`);
    attrLines.push(
      `- Original price: ${formatPriceValue(attributes.original_price, cur)}`,
    );
  } else if (
    attributes?.price_min != null &&
    attributes?.price_max != null &&
    attributes.price_min !== attributes.price_max &&
    // Don't let tiny bogus ranges (e.g. shipping "1–3 days") override real price
    Math.max(attributes.price_min, attributes.price_max) >= 5
  ) {
    attrLines.push(
      `- Price: ${formatPriceValue(attributes.price_min, cur)} – ${formatPriceValue(attributes.price_max, cur)}`,
    );
    attrLines.push(
      `- Price range: ${formatPriceValue(attributes.price_min, cur)} – ${formatPriceValue(attributes.price_max, cur)}`,
    );
  } else if (attributes?.price != null) {
    attrLines.push(`- Price: ${formatPriceValue(attributes.price, cur)}`);
  }
  if (attributes?.in_stock === true) attrLines.push("- Availability: In stock");
  if (attributes?.in_stock === false) {
    attrLines.push("- Availability: Out of stock");
  }
  if (attributes?.color) attrLines.push(`- Color: ${attributes.color}`);
  if (attributes?.size) attrLines.push(`- Size: ${attributes.size}`);

  if (attrLines.length) {
    lines.push("\n## Details");
    lines.push(attrLines.join("\n"));
  }

  if (includeShortDescription && description) {
    lines.push("\n## Description");
    lines.push(description.trim());
  }

  return stripInlineBufferImageContent(
    lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  );
}

/**
 * Product extraction: JSON-LD/DOM attributes + always-appended cleaned page body.
 * FAQ / reviews / related stay out of primary (residual / secondary FAQ own them).
 */
function extractProductContent({ url, html, jsonLdBlocks = [] }) {
  const fromLd = extractProductFromJsonLd(jsonLdBlocks);
  const fromDom = fromLd?.confidence >= 0.85 ? null : extractProductFromDom(html, url);
  const domPrices = extractProductPricesFromDom(html);

  const merged = {
    entity_name: fromLd?.entity_name || fromDom?.entity_name || null,
    description: fromLd?.description || fromDom?.description || "",
    attributes: {
      ...(fromDom?.attributes || {}),
      ...(fromLd?.attributes || {}), // JSON-LD wins for most fields
      ...mergePriceAttributes(fromLd?.attributes || {}, domPrices),
    },
    confidence: fromLd?.confidence || fromDom?.confidence || 0.3,
    source: fromLd?.source || fromDom?.source || "none",
  };

  const { markdown: bodyMarkdown, source: bodySource } = extractCleanProductBody(
    html,
    url,
  );

  const shortCovered =
    bodyMarkdown &&
    merged.description &&
    descriptionCoveredByBody(merged.description, bodyMarkdown);

  let content = productToMarkdown({
    entity_name: merged.entity_name,
    description: merged.description,
    attributes: merged.attributes,
    url,
    includeShortDescription: Boolean(merged.description) && !shortCovered,
  });

  // Always append cleaned body when available (not only when shell is thin)
  if (bodyMarkdown) {
    const heading =
      shortCovered || !merged.description
        ? "## Description"
        : "## Full details";
    const bodyNorm = normalizeForCompare(bodyMarkdown);
    const contentNorm = normalizeForCompare(content);
    const preview = bodyNorm.slice(0, Math.min(100, bodyNorm.length));
    const alreadyEmbedded =
      preview.length >= 40 && contentNorm.includes(preview);

    if (!alreadyEmbedded) {
      content = stripInlineBufferImageContent(
        `${content}\n\n${heading}\n${bodyMarkdown}`
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
    }
  }

  const sources = [merged.source];
  if (bodySource) sources.push("cleaned_body");

  const attrs = { ...(merged.attributes || {}) };
  if (url) {
    attrs.url = url;
    if (!Array.isArray(attrs.product_urls) || !attrs.product_urls.length) {
      attrs.product_urls = [url];
    }
    const price = attrs.price != null ? attrs.price : null;
    const currency = attrs.currency || null;
    if (!Array.isArray(attrs.products) || !attrs.products.length) {
      attrs.products = [
        {
          name: merged.entity_name || null,
          url,
          ...(price != null ? { price } : {}),
          ...(attrs.original_price != null
            ? { original_price: attrs.original_price }
            : {}),
          ...(attrs.price_min != null ? { price_min: attrs.price_min } : {}),
          ...(attrs.price_max != null ? { price_max: attrs.price_max } : {}),
          ...(currency ? { currency } : {}),
        },
      ];
      attrs.product_count = 1;
    }
  }

  return {
    content,
    entity_name: merged.entity_name,
    attributes: attrs,
    extraction_confidence: merged.confidence,
    extraction_source: sources.filter(Boolean).join("+"),
    body_chars: bodyMarkdown ? bodyMarkdown.length : 0,
  };
}

module.exports = {
  extractProductContent,
  extractProductFromJsonLd,
  extractProductFromDom,
  extractProductPricesFromDom,
  mergePriceAttributes,
  descriptionCoveredByBody,
};
