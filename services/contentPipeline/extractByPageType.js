const cheerio = require("cheerio");
const { extractPageMetadata } = require("./extractPageMetadata");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const {
  detectPageType,
} = require("./detectPageType");
const { classifyPageTypeLlm } = require("./classifyPageTypeLlm");
const { applyValidation } = require("./validatePage");
const { extractProductContent } = require("./extractors/product");
const { extractListingContent } = require("./extractors/listing");
const { extractWithReadability } = require("./extractors/contentReadability");
const { extractFaqContent } = require("./extractors/faq");
const { processResidualSections } = require("./residualSections");
const { GRID_SELECTORS, CARD_SELECTORS } = require("./extractors/listing");
const { resolveProductId } = require("./productId");
const {
  decodeCloudflareEmailsInHtml,
} = require("../../utils/cloudflareEmail");

/**
 * Build a section descriptor for multi-entity indexing of one URL.
 */
function buildSection({
  pageType,
  entity_type,
  entity_name = null,
  content,
  attributes = {},
  search_terms = [],
  classification_confidence = 0,
  classification_reason = "",
  extraction_source = "generic",
  product_id = null,
}) {
  return {
    pageType,
    entity_type,
    entity_name,
    content: String(content || "").trim(),
    attributes:
      attributes && typeof attributes === "object" ? { ...attributes } : {},
    search_terms: Array.isArray(search_terms) ? [...search_terms] : [],
    classification_confidence,
    classification_reason,
    extraction_source,
    product_id,
  };
}

function mergeAttrMaps(target = {}, extra = {}) {
  const out = { ...target };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const prev = Array.isArray(out[key]) ? out[key] : [];
      const set = new Set(prev.map(String));
      for (const item of value) {
        const s = String(item);
        if (!set.has(s)) {
          set.add(s);
          prev.push(item);
        }
      }
      out[key] = prev.slice(0, 80);
    } else if (out[key] == null || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * True for a single product detail URL (PDP), e.g.
 * /products/after-hours-lip-liner, /product/foo, /p/sku, /dp/asin.
 * Bare /products or /products/ (no handle) is NOT a PDP.
 */
function isProductDetailUrl(url = "") {
  if (!url) return false;
  let path = "";
  try {
    path = new URL(url, "http://localhost").pathname || "";
  } catch {
    path = String(url);
  }
  return /\/(products?|item|sku|dp|pd)\/[^/?#]+/i.test(path);
}

/**
 * True for collection / category / catalog / shop index URLs (PLP).
 * Never true for a clear PDP URL — related-product cards on a PDP must not
 * flip the page to listing (that caused Mink Envy PDP → listing extractor).
 */
function isListingUrl(url = "", $ = null) {
  // Explicit product-detail URLs always win over DOM / listing heuristics
  if (isProductDetailUrl(url)) return false;

  const path = (() => {
    try {
      return new URL(url || "", "http://localhost").pathname || "";
    } catch {
      return String(url || "");
    }
  })();

  // Collection / category / catalog / shop index (with or without handle)
  if (
    /\/(collections?|category|categories|catalog|all-products|search|browse|brands?|goods)(\/|$)/i.test(
      path,
    )
  ) {
    return true;
  }

  // /shop or /store index only (not /shop/something-product-like handled elsewhere)
  if (/\/(shop|store)\/?$/i.test(path)) return true;

  // Bare /products or /products/ with no product handle → product index listing
  if (/\/products?\/?$/i.test(path)) return true;

  // DOM multi-card heuristic only when URL is not a PDP
  if ($) {
    const cardCount = $(CARD_SELECTORS).length;
    if (cardCount >= 2) return true;
  }
  return false;
}

/**
 * After pageType=product, resolve PDP vs PLP.
 * Clear /products/{handle} URLs always force product (PDP extractor).
 * Collection/catalog URLs or multi-card DOMs force listing (PLP).
 */
function resolveProductEntityType(detection, url, $ = null) {
  if (isProductDetailUrl(url)) {
    return {
      ...detection,
      pageType: "product",
      entity_type: "product",
      reason: `${detection.reason || "rules"}+force_product_url`,
    };
  }
  if (isListingUrl(url, $)) {
    return {
      ...detection,
      pageType: "product",
      entity_type: "listing",
      reason: `${detection.reason || "rules"}+force_listing_url`,
    };
  }
  if (detection.entity_type === "listing") {
    return { ...detection, pageType: detection.pageType || "product" };
  }
  return {
    ...detection,
    entity_type: detection.entity_type || "product",
  };
}

/**
 * Phase 3 orchestrator:
 * metadata → rule page-type → optional LLM →
 * product→(PDP product extractor | PLP listing extractor) →
 * optional secondary FAQ → residual DOM sections → validation.
 */
async function extractByPageType(url, sourceCode, chromeCache = {}, usageContext = {}) {
  const {
    userId = null,
    agentId = null,
    conversationId = null,
  } = usageContext;

  // HTTP scraping does not execute Cloudflare's client-side email decoder.
  // Normalize protected addresses once before any typed or generic extractor runs.
  const decodedSourceCode = decodeCloudflareEmailsInHtml(sourceCode);
  const $meta = cheerio.load(decodedSourceCode);
  const pageMetadata = extractPageMetadata($meta, url);
  const textSample = $meta("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);

  // 1) Rule-based detection
  let detection = detectPageType({
    url,
    schemaTypes: pageMetadata.schemaTypes || [],
    title: pageMetadata.title,
    metaDescription: pageMetadata.metaDescription,
    textSample,
    $: $meta,
  });

  // 2) LLM only when rules are ambiguous AND page is not deterministic
  let llmResult = null;
  if (detection.needsLlm && !detection.deterministic) {
    llmResult = await classifyPageTypeLlm({
      url,
      title: pageMetadata.title,
      metaDescription: pageMetadata.metaDescription,
      schemaTypes: pageMetadata.schemaTypes || [],
      textSample,
      ruleGuess: detection,
      userId,
      agentId,
      conversationId,
    });

    if (llmResult) {
      detection = {
        ...detection,
        pageType: llmResult.pageType || detection.pageType,
        entity_type: llmResult.entity_type || detection.entity_type,
        confidence: Math.max(detection.confidence, llmResult.confidence || 0),
        reason: `${detection.reason}+${llmResult.reason || "llm"}`,
        needsLlm: false,
      };
    }
  } else {
    const { recordPageTypeLlmUsage } = require("./llmUsageStats");
    recordPageTypeLlmUsage({
      skipped: true,
      skipReason: detection.deterministic
        ? "deterministic_page_short_circuit"
        : "rules_confident",
    });
  }

  // 2b) product pageType → PDP vs PLP entity split
  if (detection.pageType === "product") {
    detection = resolveProductEntityType(detection, url, $meta);
  }

  const isListing =
    detection.pageType === "product" && detection.entity_type === "listing";
  const isPdp =
    detection.pageType === "product" && detection.entity_type !== "listing";

  // 3) Typed extraction — branch product vs listing
  let typed = null;
  if (isListing) {
    typed = extractListingContent({
      url,
      html: decodedSourceCode,
      jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
      title: pageMetadata.title,
      metaDescription: pageMetadata.metaDescription,
    });
  } else if (isPdp) {
    typed = extractProductContent({
      url,
      html: decodedSourceCode,
      jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
    });
  } else if (["faq", "blog", "docs"].includes(detection.pageType)) {
    typed = extractWithReadability(url, decodedSourceCode);
  }

  // Always have a generic fallback for chrome/homepage + thin typed extracts
  const generic = extractGenericMarkdown(url, decodedSourceCode, chromeCache);

  let content = typed?.content || "";
  let extraction_source = typed?.extraction_source || "generic";
  let entity_name = typed?.entity_name || null;
  let attributes = typed?.attributes || {};

  const PDP_THIN_THRESHOLD = 250;

  if (!content || content.length < 80) {
    if (isListing && content && content.length >= 40) {
      // PLP: keep listing markdown even if modest; do not replace with noisy generic.
      extraction_source = typed?.extraction_source || extraction_source;
    } else {
      content = generic.content;
      extraction_source =
        typed && typed.content ? `${typed.extraction_source}+generic` : "generic";
      if (!entity_name && detection.pageType !== "product") {
        entity_name = generic.title || null;
      }
    }
  } else if (
    isPdp &&
    content.length < PDP_THIN_THRESHOLD &&
    generic?.content &&
    generic.content.length > content.length
  ) {
    // PDP still thin after structured+cleaned body → merge chrome-stripped generic
    const genericBody = String(generic.content || "").trim();
    const alreadyHas = content
      .toLowerCase()
      .includes(genericBody.slice(0, 80).toLowerCase());
    if (!alreadyHas && genericBody.length >= 80) {
      content = `${content}\n\n## Page content\n${genericBody}`
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      extraction_source = `${extraction_source}+generic`;
    }
  }

  const base = {
    pageType: detection.pageType,
    entity_type: detection.entity_type,
    entity_name,
    content,
    title: generic.title || pageMetadata.title,
    metaDescription: generic.metaDescription || pageMetadata.metaDescription,
    canonicalUrl: generic.canonicalUrl || pageMetadata.canonicalUrl,
    language: generic.language || pageMetadata.language || "en",
    attributes,
    search_terms: [],
    classification_confidence: detection.confidence,
    classification_reason: detection.reason,
    extraction_source,
  };

  // 4) Validation — deterministic wins over LLM
  const validated = applyValidation(base, llmResult);
  // Re-assert PDP / PLP after validation (URL rules beat LLM / weak DOM)
  if (isProductDetailUrl(url)) {
    validated.entity_type = "product";
    validated.pageType = "product";
  } else if (isListingUrl(url) || isListing) {
    // LLM must not flip a real PLP → product
    validated.entity_type = "listing";
    validated.pageType = "product";
  }

  const pageProductId = isPdp
    ? resolveProductId({
        url,
        canonicalUrl: validated.canonicalUrl || pageMetadata.canonicalUrl,
        attributes: validated.attributes,
        entity_name: validated.entity_name,
        entity_type: "product",
        jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
        html: decodedSourceCode,
      })
    : null;

  if (pageProductId) {
    validated.attributes = {
      ...validated.attributes,
      product_id: pageProductId,
    };
  }

  // 5) Multi-section: primary + optional product FAQ + residual DOM sections
  const sections = [];
  const primarySection = buildSection({
    pageType: validated.pageType,
    entity_type: validated.entity_type,
    entity_name: validated.entity_name,
    content: validated.content,
    attributes: validated.attributes,
    search_terms: validated.search_terms,
    classification_confidence: validated.classification_confidence,
    classification_reason: validated.classification_reason,
    extraction_source: validated.extraction_source,
    product_id: pageProductId,
  });
  sections.push(primarySection);

  let faqExtracted = false;
  // Secondary FAQ only on real PDPs — not PLP/collection pages
  if (isPdp && !isListingUrl(url)) {
    const faq = extractFaqContent({
      html: decodedSourceCode,
      jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
      title: validated.title || pageMetadata.title,
    });

    if (faq?.content && faq.content.length >= 40) {
      const productBody = validated.content.toLowerCase();
      const faqAlreadyEmbedded =
        Array.isArray(faq.pairs) &&
        faq.pairs.length > 0 &&
        faq.pairs.every(
          (p) =>
            productBody.includes(String(p.question).toLowerCase()) &&
            productBody.includes(
              String(p.answer).slice(0, 80).toLowerCase(),
            ),
        );

      if (!faqAlreadyEmbedded) {
        faqExtracted = true;
        sections.push(
          buildSection({
            pageType: "faq",
            entity_type: "faq",
            entity_name: faq.entity_name,
            content: faq.content,
            attributes: {},
            search_terms: [],
            classification_confidence: faq.extraction_confidence || 0.85,
            classification_reason: `secondary_section:${faq.extraction_source}`,
            extraction_source: faq.extraction_source,
            product_id: pageProductId,
          }),
        );
      }
    }
  }

  // 6) Residual scan: uncovered DOM → link-list attrs + prose sections
  // On PLPs, mark the product grid covered so residual doesn't re-index cards as related links.
  let residualStats = null;
  try {
    const extraCoveredSelectors = isListing
      ? GRID_SELECTORS.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const residual = await processResidualSections({
      html: decodedSourceCode,
      pageType: validated.pageType,
      existingSections: sections,
      markFaqCovered: faqExtracted || validated.pageType === "faq",
      extraCoveredSelectors,
      deterministicPage: Boolean(detection.deterministic || isListing),
      usageContext: { userId, agentId, conversationId },
    });
    residualStats = residual.stats;

    if (
      residual.pageAttributes &&
      Object.keys(residual.pageAttributes).length > 0
    ) {
      // Don't let residual related_product_urls overwrite listing product_urls
      const residualAttrs = { ...residual.pageAttributes };
      if (isListing && validated.attributes?.product_urls?.length) {
        delete residualAttrs.related_product_urls;
      }
      sections[0].attributes = mergeAttrMaps(
        sections[0].attributes,
        residualAttrs,
      );
      validated.attributes = sections[0].attributes;
    }

    for (const sec of residual.sections || []) {
      if (!sec.content || sec.content.length < 40) continue;
      sections.push(
        buildSection({
          pageType: sec.pageType,
          entity_type: sec.entity_type,
          entity_name: sec.entity_name,
          content: sec.content,
          attributes: sec.attributes,
          search_terms: sec.search_terms,
          classification_confidence: sec.classification_confidence,
          classification_reason: sec.classification_reason,
          extraction_source: sec.extraction_source,
          product_id:
            sec.entity_type === "product" || sec.pageType === "product"
              ? pageProductId
              : null,
        }),
      );
    }
  } catch (err) {
    console.warn(
      `[extractByPageType] residual sections failed for ${url}: ${err.message}`,
    );
  }

  // Combined content for storage sizing / Url contentHash of the page as a whole
  const combinedContent = sections
    .map((s) => s.content)
    .filter(Boolean)
    .join("\n\n---\n\n");

  return {
    content: combinedContent || validated.content,
    webPageURL: url,
    title: validated.title,
    metaDescription: validated.metaDescription,
    canonicalUrl: validated.canonicalUrl,
    language: validated.language,
    pageMetadata,
    pageType: validated.pageType,
    entity_type: validated.entity_type,
    entity_name: validated.entity_name,
    attributes: validated.attributes,
    search_terms: validated.search_terms,
    product_id: pageProductId,
    classification_confidence: validated.classification_confidence,
    classification_reason: validated.classification_reason,
    extraction_source: validated.extraction_source,
    deterministic: Boolean(detection.deterministic),
    sections,
    residualStats,
  };
}

module.exports = {
  extractByPageType,
  buildSection,
  resolveProductEntityType,
  isListingUrl,
  isProductDetailUrl,
};
