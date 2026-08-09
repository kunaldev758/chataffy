const { normalizePage } = require("./ingestion/normalizer");
const { checkQualityGates } = require("./ingestion/qualityGate");
const {
  generateContextualSummary,
} = require("./ingestion/contextualSummarizer");
const { parseDocumentStructure } = require("./ingestion/structureParser");
const { createParentChildChunks } = require("./ingestion/tokenSplitter");
const {
  formatAttrContextLine,
  unionAttrs,
  termsFromProductAttrs,
} = require("./contentPipeline/extractors/productVariants");

/**
 * Map test-backend page types → Chataffy pageType / entity_type used by retrieval filters.
 */
function mapPageTypes(testPageType = "general_page") {
  const map = {
    product_page: { pageType: "product", entity_type: "product" },
    faq_page: { pageType: "faq", entity_type: "faq" },
    contact_page: { pageType: "generic", entity_type: "general" },
    about_page: { pageType: "generic", entity_type: "about" },
    service_page: { pageType: "generic", entity_type: "service" },
    blog_page: { pageType: "blog", entity_type: "blog_post" },
    pricing_page: { pageType: "product", entity_type: "product" },
    homepage: { pageType: "generic", entity_type: "general" },
    general_page: { pageType: "generic", entity_type: "general" },
  };
  return map[testPageType] || map.general_page;
}

function parentIndexFromId(parentId) {
  const match = String(parentId || "").match(/^parent_(\d+)_/);
  return match ? Number(match[1]) : 0;
}

function childIndexFromId(childIndex) {
  if (typeof childIndex === "number") return childIndex;
  const parts = String(childIndex || "").split("_");
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build ecommerce/contact attributes for Chataffy payload.attributes.
 */
function buildAttributesFromMeta(ecommerceMeta = {}, contactInfo = {}) {
  const attrs = {};
  if (ecommerceMeta.priceNumeric != null) {
    attrs.price = ecommerceMeta.priceNumeric;
  }
  if (ecommerceMeta.currency) attrs.currency = ecommerceMeta.currency;
  if (ecommerceMeta.inStock != null) attrs.inStock = ecommerceMeta.inStock;
  if (Array.isArray(ecommerceMeta.colors) && ecommerceMeta.colors.length) {
    attrs.colors = ecommerceMeta.colors;
  }
  if (Array.isArray(ecommerceMeta.sizes) && ecommerceMeta.sizes.length) {
    attrs.sizes = ecommerceMeta.sizes;
  }
  if (Array.isArray(contactInfo.emails) && contactInfo.emails.length) {
    attrs.contactEmails = contactInfo.emails;
  }
  if (Array.isArray(contactInfo.phones) && contactInfo.phones.length) {
    attrs.contactPhones = contactInfo.phones;
  }
  return attrs;
}

function mergeUniqueStrings(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const s = String(raw || "").trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * Prefer extractor arrays; fill from ecommerce regex heuristics.
 */
function resolveProductFacetLists(extraAttributes = {}, ecommerceMeta = {}) {
  const fromExtraColors = Array.isArray(extraAttributes.colors)
    ? extraAttributes.colors
    : extraAttributes.color
      ? [extraAttributes.color]
      : [];
  const fromExtraSizes = Array.isArray(extraAttributes.sizes)
    ? extraAttributes.sizes
    : extraAttributes.size
      ? [extraAttributes.size]
      : [];
  return {
    colors: mergeUniqueStrings(fromExtraColors, ecommerceMeta.colors),
    sizes: mergeUniqueStrings(fromExtraSizes, ecommerceMeta.sizes),
  };
}

function appendAttrLineToContextual(contextualText, attrLine) {
  if (!attrLine) return contextualText || "";
  const base = String(contextualText || "").trim();
  if (!base) return `[Product Attrs: ${attrLine}]`;
  if (base.includes(attrLine)) return base;
  return `${base}\n[Product Attrs: ${attrLine}]`;
}

/**
 * Full RAG Ingestion Pipeline — Stages B through H (chunking).
 * Embedding + Qdrant upsert stay in Chataffy QdrantService (named dense+sparse).
 *
 * @param {string} rawInput - HTML or markdown/plain text
 * @param {string} url
 * @param {object} options
 * @returns {Promise<object>}
 */
async function processPageForIngestion(rawInput, url = "", options = {}) {
  console.log(
    `\n[Ingestion Flow] Starting processing for: ${url || "Raw Input"}`,
  );

  // Stage B: Page Normalization & Metadata Extraction
  const normalized = normalizePage(rawInput, url);
  console.log(
    `  ├─ Stage B (Normalized): "${normalized.pageTitle}" | type=${normalized.pageType} | words=${normalized.metrics.wordCount}`,
  );

  // Stage C: Quality Gates
  // Webpages: strict (test-backend). Snippets/files/FAQs: lenient so short content still trains.
  const qualityMode = options.qualityMode === "lenient" ? "lenient" : "strict";
  const quality = checkQualityGates(normalized, { mode: qualityMode });
  if (!quality.pass) {
    console.warn(`  └─ Stage C (Quality Gate FAIL): ${quality.reason}`);
    return {
      skipped: true,
      skipReason: quality.reason,
      pageTitle: normalized.pageTitle,
      pageType: normalized.pageType,
      url,
      metrics: normalized.metrics,
      normalizedText: normalized.rawText || "",
      contextualSummary: "",
      parentCount: 0,
      childCount: 0,
      childChunks: [],
      chunks: [],
    };
  }
  console.log(
    `  ├─ Stage C (Quality Gate PASS): Text quality verified (${qualityMode})`,
  );

  // Stages E & F: Contextual Summary & Document Structure
  const [contextualSummary, structures] = await Promise.all([
    generateContextualSummary(normalized, options),
    Promise.resolve(parseDocumentStructure(normalized.rawText)),
  ]);
  console.log(
    `  ├─ Stage E (Contextual Summary): "${contextualSummary.slice(0, 80)}..."`,
  );
  console.log(
    `  ├─ Stage F (Structure): ${structures.length} structural blocks`,
  );

  // Stages G & H: Token-Aware Parent-Child Chunking (850 / 350)
  const pageMeta = {
    pageTitle: normalized.pageTitle,
    pageType: normalized.pageType,
    contactEmails: normalized.contactInfo.emails,
    contactPhones: normalized.contactInfo.phones,
    ecommerceMeta: normalized.ecommerceMeta,
    url,
  };

  const { parentChunks, childChunks } = createParentChildChunks(
    normalized.rawText,
    contextualSummary,
    pageMeta,
    structures,
  );
  console.log(
    `  └─ Stage G-H (Parent-Child Chunks): ${parentChunks.length} Parents (850 tokens), ${childChunks.length} Children (350 tokens)`,
  );

  const mapped = mapPageTypes(normalized.pageType);
  // Prefer extract-pipeline types when caller provides them (retrieval compatibility)
  const pageType = options.preferPageType || mapped.pageType;
  const entity_type = options.preferEntityType || mapped.entity_type;
  const extraAttributes =
    options.extraAttributes && typeof options.extraAttributes === "object"
      ? options.extraAttributes
      : {};
  const facetLists = resolveProductFacetLists(
    extraAttributes,
    normalized.ecommerceMeta || {},
  );
  const metaAttributes = unionAttrs(
    buildAttributesFromMeta(normalized.ecommerceMeta, normalized.contactInfo),
    {
      ...extraAttributes,
      colors: facetLists.colors,
      sizes: facetLists.sizes,
    },
  );
  const entityName =
    options.preferEntityName || normalized.pageTitle || null;
  const productId = options.productId || null;
  const searchTerms = mergeUniqueStrings(
    options.searchTerms,
    termsFromProductAttrs(metaAttributes, entityName),
  );
  const attrContextLine = formatAttrContextLine(metaAttributes);

  // Chataffy upsert shape: embed children, generate on parent_text
  const chunks = childChunks.map((chunk, index) => ({
    text: chunk.text,
    parent_text: chunk.parentText,
    parent_id: chunk.parentId,
    parent_index: parentIndexFromId(chunk.parentId),
    child_index: childIndexFromId(chunk.childIndex),
    chunk_role: "child",
    heading_path: "",
    contextualText: appendAttrLineToContextual(
      chunk.contextualText,
      attrContextLine,
    ),
    pageType,
    entity_type,
    entity_name: entityName,
    product_id: productId,
    attributes: { ...metaAttributes },
    search_terms: searchTerms,
    classification_confidence:
      typeof options.classificationConfidence === "number"
        ? options.classificationConfidence
        : 1,
    classification_reason:
      options.classificationReason || "test_backend_ingestion",
    quality_score: null,
    priceNumeric:
      metaAttributes.price ?? normalized.ecommerceMeta?.priceNumeric ?? null,
    currency:
      metaAttributes.currency || normalized.ecommerceMeta?.currency || null,
    inStock:
      metaAttributes.in_stock ?? normalized.ecommerceMeta?.inStock ?? null,
    colors: facetLists.colors,
    sizes: facetLists.sizes,
    contactEmails: normalized.contactInfo?.emails || [],
    contactPhones: normalized.contactInfo?.phones || [],
    tokenCount: chunk.tokenCount || 0,
    _index: index,
  }));

  return {
    skipped: false,
    pageTitle: normalized.pageTitle,
    pageType,
    sourcePageType: normalized.pageType,
    entity_type,
    normalizedText: normalized.rawText,
    url,
    contextualSummary,
    parentCount: parentChunks.length,
    childCount: childChunks.length,
    metrics: normalized.metrics,
    contentHash: normalized.contentHash || null,
    ecommerceMeta: normalized.ecommerceMeta || {},
    contactInfo: normalized.contactInfo || { emails: [], phones: [] },
    attributes: metaAttributes,
    search_terms: searchTerms,
    colors: facetLists.colors,
    sizes: facetLists.sizes,
    childChunks,
    parentChunks,
    chunks,
  };
}

module.exports = {
  processPageForIngestion,
  mapPageTypes,
  buildAttributesFromMeta,
};
