/**
 * Split retrieved listing/PDP text into MAIN CATALOG (has real product URL)
 * vs SUGGESTION-ONLY (useful context, no navigational URL).
 *
 * Keeps all RAG matches; filters at product-block level so unlinked products
 * remain available for soft suggestions without leaking into the main list.
 */

const PRODUCT_HEADING_RE = /^##\s*Product\b[^\n]*/gim;
const PRODUCT_URL_LINE_RE =
  /Product URL:\s*(?:\n\s*)?(https?:\/\/[^\s<>"'\\]+)/i;
const NAME_LINE_RE = /Name:\s*(?:\n\s*)?([^\n]+)/i;
const H1_NAME_RE = /^#\s+([^\n#]+)/m;

function trimTrailingUrlJunk(url) {
  return String(url || "").trim().replace(/[.,;:)\]\}]+$/g, "");
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+/i.test(String(value || "").trim());
}

function normalizeNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractProductUrl(block) {
  const match = String(block || "").match(PRODUCT_URL_LINE_RE);
  if (!match) return null;
  const url = trimTrailingUrlJunk(match[1]);
  return isHttpUrl(url) ? url : null;
}

function extractProductName(block) {
  const fromName = String(block || "").match(NAME_LINE_RE);
  if (fromName?.[1]) return fromName[1].trim();
  const fromH1 = String(block || "").match(H1_NAME_RE);
  if (fromH1?.[1]) return fromH1[1].trim();
  return null;
}

/**
 * Split listing markdown into ## Product blocks.
 * @returns {string[]|null} null when no listing product headings found
 */
function splitListingProductBlocks(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;

  PRODUCT_HEADING_RE.lastIndex = 0;
  const starts = [];
  let match;
  while ((match = PRODUCT_HEADING_RE.exec(raw)) !== null) {
    starts.push(match.index);
  }
  if (starts.length === 0) return null;

  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : raw.length;
    const block = raw.slice(start, end).trim();
    if (!block || /_No products extracted\._/i.test(block)) continue;
    blocks.push(block);
  }
  return blocks.length ? blocks : null;
}

/**
 * PDP-style chunk (# Title + optional Product URL) as one product.
 * Page URL is only used when entity_type is product (never for listings).
 */
function extractPdpProduct(text, pageUrl, entityType) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const name = extractProductName(raw);
  if (!name) return null;

  const inlineUrl = extractProductUrl(raw);
  const canUsePageUrl =
    String(entityType || "").toLowerCase() === "product" && isHttpUrl(pageUrl);
  const url = inlineUrl || (canUsePageUrl ? trimTrailingUrlJunk(pageUrl) : null);

  return {
    name,
    url,
    raw,
  };
}

function productDedupeKey(product) {
  const nameKey = normalizeNameKey(product.name) || "unknown";
  const urlKey = product.url ? product.url.toLowerCase() : "no-url";
  return `${nameKey}::${urlKey}`;
}

/**
 * Extract products from one chunk of retrieved text.
 */
function extractProductsFromText(text, { pageUrl = "", entityType = "" } = {}) {
  const listingBlocks = splitListingProductBlocks(text);
  if (listingBlocks) {
    return listingBlocks.map((raw) => ({
      name: extractProductName(raw),
      // Never promote collection page URL onto listing cards without Product URL
      url: extractProductUrl(raw),
      raw,
    }));
  }

  const pdp = extractPdpProduct(text, pageUrl, entityType);
  return pdp ? [pdp] : [];
}

/**
 * Partition all products found in RAG matches.
 * Does not drop matches — only classifies extracted product blocks.
 */
function partitionProductsFromMatches(matches = []) {
  const mainCatalog = [];
  const suggestionOnly = [];
  const seen = new Set();

  for (const match of matches) {
    const payload = match?.payload || {};
    const text = payload.text || payload.pageContent || "";
    if (!text) continue;

    const products = extractProductsFromText(text, {
      pageUrl: payload.url || "",
      entityType: payload.entity_type || payload.entityType || "",
    });

    for (const product of products) {
      const key = productDedupeKey(product);
      if (seen.has(key)) continue;
      seen.add(key);

      if (product.url) {
        mainCatalog.push(product);
      } else {
        suggestionOnly.push(product);
      }
    }
  }

  return { mainCatalog, suggestionOnly };
}

function formatProductSection(products, heading, guidance) {
  if (!products.length) return "";
  const body = products.map((p) => p.raw).join("\n\n");
  return `${heading}\n${guidance}\n\n${body}`;
}

/**
 * Build controlled list context: MAIN CATALOG + SUGGESTION-ONLY.
 * Reserves budget for both sections so suggestions are not starved.
 *
 * @returns {{ context: string|null, mainCount: number, suggestionCount: number }}
 *   context is null when no product blocks were extracted (caller should fall back).
 */
function buildControlledCatalogContext(matches, options = {}) {
  const maxTotalChars = options.maxTotalChars ?? 3000;
  const suggestionShare = Math.min(
    Math.max(options.suggestionShare ?? 0.3, 0.15),
    0.45,
  );
  const maxSuggestions = options.maxSuggestions ?? 8;
  const maxMain = options.maxMain ?? 40;

  const { mainCatalog, suggestionOnly } = partitionProductsFromMatches(matches);
  if (!mainCatalog.length && !suggestionOnly.length) {
    return { context: null, mainCount: 0, suggestionCount: 0 };
  }

  const suggestionBudget = Math.floor(maxTotalChars * suggestionShare);
  const mainBudget = Math.max(400, maxTotalChars - suggestionBudget);

  const mainTrimmed = [];
  let mainChars = 0;
  for (const product of mainCatalog.slice(0, maxMain)) {
    const size = product.raw.length + 2;
    if (mainTrimmed.length > 0 && mainChars + size > mainBudget) break;
    mainTrimmed.push(product);
    mainChars += size;
  }

  const suggestionTrimmed = [];
  let suggestionChars = 0;
  for (const product of suggestionOnly.slice(0, maxSuggestions)) {
    const size = product.raw.length + 2;
    if (suggestionTrimmed.length > 0 && suggestionChars + size > suggestionBudget) {
      break;
    }
    suggestionTrimmed.push(product);
    suggestionChars += size;
  }

  const parts = [];

  const mainSection = formatProductSection(
    mainTrimmed,
    "## MAIN CATALOG",
    "Only these products have a real Product URL. Put ONLY these in the navigational Name / Price / Link list. Include Price only when present. Always include Link from Product URL. Never invent a URL.",
  );
  if (mainSection) parts.push(mainSection);

  const suggestionSection = formatProductSection(
    suggestionTrimmed,
    "## SUGGESTION-ONLY",
    "These products have no Product URL. Do NOT include them in the main Name/Price/Link list. You may mention them by name (and price if present) only as soft suggestions. Never invent a Link or write \"Not available\".",
  );
  if (suggestionSection) parts.push(suggestionSection);

  let context = parts.join("\n\n");
  if (context.length > maxTotalChars) {
    context = `${context.slice(0, Math.max(0, maxTotalChars - 1))}…`;
  }

  return {
    context,
    mainCount: mainTrimmed.length,
    suggestionCount: suggestionTrimmed.length,
  };
}

module.exports = {
  extractProductUrl,
  extractProductName,
  splitListingProductBlocks,
  extractProductsFromText,
  partitionProductsFromMatches,
  buildControlledCatalogContext,
};
