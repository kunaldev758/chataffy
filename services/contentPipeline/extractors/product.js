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
      price:
        offer?.price != null
          ? Number(offer.price)
          : offer?.lowPrice != null
            ? Number(offer.lowPrice)
            : null,
      currency: offer?.priceCurrency || null,
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

  const priceText =
    $('[itemprop="price"]').attr("content") ||
    $('[itemprop="price"]').first().text() ||
    $(".price, .product-price, [class*='price']").first().text() ||
    "";
  const priceMatch = String(priceText).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  const price = priceMatch ? Number(priceMatch[1]) : null;

  const sku =
    $('[itemprop="sku"]').attr("content") ||
    $('[itemprop="sku"]').first().text().trim() ||
    null;

  const attrs = {};
  if (price != null && !Number.isNaN(price)) attrs.price = price;
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
  if (url) lines.push(`\nURL: ${url}`);

  const attrLines = [];
  if (attributes?.sku) attrLines.push(`- SKU: ${attributes.sku}`);
  if (attributes?.brand) attrLines.push(`- Brand: ${attributes.brand}`);
  if (attributes?.price != null) {
    const cur = attributes.currency ? ` ${attributes.currency}` : "";
    attrLines.push(`- Price: ${attributes.price}${cur}`);
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

  const merged = {
    entity_name: fromLd?.entity_name || fromDom?.entity_name || null,
    description: fromLd?.description || fromDom?.description || "",
    attributes: {
      ...(fromDom?.attributes || {}),
      ...(fromLd?.attributes || {}), // JSON-LD wins
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

  return {
    content,
    entity_name: merged.entity_name,
    attributes: merged.attributes,
    extraction_confidence: merged.confidence,
    extraction_source: sources.filter(Boolean).join("+"),
    body_chars: bodyMarkdown ? bodyMarkdown.length : 0,
  };
}

module.exports = {
  extractProductContent,
  extractProductFromJsonLd,
  extractProductFromDom,
  descriptionCoveredByBody,
};
