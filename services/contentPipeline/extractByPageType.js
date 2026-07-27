// const cheerio = require("cheerio");
// const { extractPageMetadata } = require("./extractPageMetadata");
// const { extractGenericMarkdown } = require("./extractGenericMarkdown");
// const {
//   detectPageType,
// } = require("./detectPageType");
// const { classifyPageTypeLlm } = require("./classifyPageTypeLlm");
// const { applyValidation } = require("./validatePage");
// const { extractProductContent } = require("./extractors/product");
// const { extractListingContent } = require("./extractors/listing");
// const { extractWithReadability } = require("./extractors/contentReadability");
// const { extractFaqContent } = require("./extractors/faq");
// const { processResidualSections } = require("./residualSections");
// const { GRID_SELECTORS } = require("./extractors/listing");

// /**
//  * Build a section descriptor for multi-entity indexing of one URL.
//  */
// function buildSection({
//   pageType,
//   entity_type,
//   entity_name = null,
//   content,
//   attributes = {},
//   search_terms = [],
//   classification_confidence = 0,
//   classification_reason = "",
//   extraction_source = "generic",
// }) {
//   return {
//     pageType,
//     entity_type,
//     entity_name,
//     content: String(content || "").trim(),
//     attributes:
//       attributes && typeof attributes === "object" ? { ...attributes } : {},
//     search_terms: Array.isArray(search_terms) ? [...search_terms] : [],
//     classification_confidence,
//     classification_reason,
//     extraction_source,
//   };
// }

// function mergeAttrMaps(target = {}, extra = {}) {
//   const out = { ...target };
//   for (const [key, value] of Object.entries(extra || {})) {
//     if (value == null) continue;
//     if (Array.isArray(value)) {
//       const prev = Array.isArray(out[key]) ? out[key] : [];
//       const set = new Set(prev.map(String));
//       for (const item of value) {
//         const s = String(item);
//         if (!set.has(s)) {
//           set.add(s);
//           prev.push(item);
//         }
//       }
//       out[key] = prev.slice(0, 80);
//     } else if (out[key] == null || out[key] === "") {
//       out[key] = value;
//     }
//   }
//   return out;
// }

// function isListingUrl(url = "") {
//   return /\/(collections?|category|categories|catalog)(\/|$)/i.test(url || "");
// }

// /**
//  * After pageType=product, resolve PDP vs PLP.
//  * Collection/catalog URLs always force listing.
//  */
// function resolveProductEntityType(detection, url) {
//   if (isListingUrl(url)) {
//     return {
//       ...detection,
//       pageType: "product",
//       entity_type: "listing",
//       reason: `${detection.reason || "rules"}+force_listing_url`,
//     };
//   }
//   if (detection.entity_type === "listing") {
//     return { ...detection, pageType: detection.pageType || "product" };
//   }
//   return {
//     ...detection,
//     entity_type: detection.entity_type || "product",
//   };
// }

// /**
//  * Phase 3 orchestrator:
//  * metadata → rule page-type → optional LLM →
//  * product→(PDP product extractor | PLP listing extractor) →
//  * optional secondary FAQ → residual DOM sections → validation.
//  */
// async function extractByPageType(url, sourceCode, chromeCache = {}, usageContext = {}) {
//   const {
//     userId = null,
//     agentId = null,
//     conversationId = null,
//   } = usageContext;

//   const $meta = cheerio.load(sourceCode);
//   const pageMetadata = extractPageMetadata($meta, url);
//   const textSample = $meta("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);

//   // 1) Rule-based detection
//   let detection = detectPageType({
//     url,
//     schemaTypes: pageMetadata.schemaTypes || [],
//     title: pageMetadata.title,
//     metaDescription: pageMetadata.metaDescription,
//     textSample,
//     $: $meta,
//   });

//   // 2) LLM only when rules are ambiguous AND page is not deterministic
//   let llmResult = null;
//   if (detection.needsLlm && !detection.deterministic) {
//     llmResult = await classifyPageTypeLlm({
//       url,
//       title: pageMetadata.title,
//       metaDescription: pageMetadata.metaDescription,
//       schemaTypes: pageMetadata.schemaTypes || [],
//       textSample,
//       ruleGuess: detection,
//       userId,
//       agentId,
//       conversationId,
//     });

//     if (llmResult) {
//       detection = {
//         ...detection,
//         pageType: llmResult.pageType || detection.pageType,
//         entity_type: llmResult.entity_type || detection.entity_type,
//         confidence: Math.max(detection.confidence, llmResult.confidence || 0),
//         reason: `${detection.reason}+${llmResult.reason || "llm"}`,
//         needsLlm: false,
//       };
//     }
//   } else {
//     const { recordPageTypeLlmUsage } = require("./llmUsageStats");
//     recordPageTypeLlmUsage({
//       skipped: true,
//       skipReason: detection.deterministic
//         ? "deterministic_page_short_circuit"
//         : "rules_confident",
//     });
//   }

//   // 2b) product pageType → PDP vs PLP entity split
//   if (detection.pageType === "product") {
//     detection = resolveProductEntityType(detection, url);
//   }

//   const isListing =
//     detection.pageType === "product" && detection.entity_type === "listing";
//   const isPdp =
//     detection.pageType === "product" && detection.entity_type !== "listing";

//   // 3) Typed extraction — branch product vs listing
//   let typed = null;
//   if (isListing) {
//     typed = extractListingContent({
//       url,
//       html: sourceCode,
//       jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
//       title: pageMetadata.title,
//       metaDescription: pageMetadata.metaDescription,
//     });
//   } else if (isPdp) {
//     typed = extractProductContent({
//       url,
//       html: sourceCode,
//       jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
//     });
//   } else if (["faq", "blog", "docs"].includes(detection.pageType)) {
//     typed = extractWithReadability(url, sourceCode);
//   }

//   // Always have a generic fallback for chrome/homepage + thin typed extracts
//   const generic = extractGenericMarkdown(url, sourceCode, chromeCache);

//   let content = typed?.content || "";
//   let extraction_source = typed?.extraction_source || "generic";
//   let entity_name = typed?.entity_name || null;
//   let attributes = typed?.attributes || {};

//   if (!content || content.length < 80) {
//     if (isPdp && content && content.length >= 40) {
//       // PDP: keep thin structured shell; residual adds body sections.
//       extraction_source = typed?.extraction_source || extraction_source;
//     } else if (isListing && content && content.length >= 40) {
//       // PLP: keep listing markdown even if modest; do not replace with noisy generic.
//       extraction_source = typed?.extraction_source || extraction_source;
//     } else {
//       content = generic.content;
//       extraction_source =
//         typed && typed.content ? `${typed.extraction_source}+generic` : "generic";
//       if (!entity_name && detection.pageType !== "product") {
//         entity_name = generic.title || null;
//       }
//     }
//   }

//   const base = {
//     pageType: detection.pageType,
//     entity_type: detection.entity_type,
//     entity_name,
//     content,
//     title: generic.title || pageMetadata.title,
//     metaDescription: generic.metaDescription || pageMetadata.metaDescription,
//     canonicalUrl: generic.canonicalUrl || pageMetadata.canonicalUrl,
//     language: generic.language || pageMetadata.language || "en",
//     attributes,
//     search_terms: [],
//     classification_confidence: detection.confidence,
//     classification_reason: detection.reason,
//     extraction_source,
//   };

//   // 4) Validation — deterministic wins over LLM
//   const validated = applyValidation(base, llmResult);
//   // Re-assert listing after validation (LLM must not flip PLP → product)
//   if (isListingUrl(url) || isListing) {
//     validated.entity_type = "listing";
//     validated.pageType = "product";
//   }

//   // 5) Multi-section: primary + optional product FAQ + residual DOM sections
//   const sections = [];
//   const primarySection = buildSection({
//     pageType: validated.pageType,
//     entity_type: validated.entity_type,
//     entity_name: validated.entity_name,
//     content: validated.content,
//     attributes: validated.attributes,
//     search_terms: validated.search_terms,
//     classification_confidence: validated.classification_confidence,
//     classification_reason: validated.classification_reason,
//     extraction_source: validated.extraction_source,
//   });
//   sections.push(primarySection);

//   let faqExtracted = false;
//   // Secondary FAQ only on real PDPs — not PLP/collection pages
//   if (isPdp && !isListingUrl(url)) {
//     const faq = extractFaqContent({
//       html: sourceCode,
//       jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
//       title: validated.title || pageMetadata.title,
//     });

//     if (faq?.content && faq.content.length >= 40) {
//       const productBody = validated.content.toLowerCase();
//       const faqAlreadyEmbedded =
//         Array.isArray(faq.pairs) &&
//         faq.pairs.length > 0 &&
//         faq.pairs.every(
//           (p) =>
//             productBody.includes(String(p.question).toLowerCase()) &&
//             productBody.includes(
//               String(p.answer).slice(0, 80).toLowerCase(),
//             ),
//         );

//       if (!faqAlreadyEmbedded) {
//         faqExtracted = true;
//         sections.push(
//           buildSection({
//             pageType: "faq",
//             entity_type: "faq",
//             entity_name: faq.entity_name,
//             content: faq.content,
//             attributes: {},
//             search_terms: [],
//             classification_confidence: faq.extraction_confidence || 0.85,
//             classification_reason: `secondary_section:${faq.extraction_source}`,
//             extraction_source: faq.extraction_source,
//           }),
//         );
//       }
//     }
//   }

//   // 6) Residual scan: uncovered DOM → link-list attrs + prose sections
//   // On PLPs, mark the product grid covered so residual doesn't re-index cards as related links.
//   let residualStats = null;
//   try {
//     const extraCoveredSelectors = isListing
//       ? GRID_SELECTORS.split(",").map((s) => s.trim()).filter(Boolean)
//       : [];

//     const residual = await processResidualSections({
//       html: sourceCode,
//       pageType: validated.pageType,
//       existingSections: sections,
//       markFaqCovered: faqExtracted || validated.pageType === "faq",
//       extraCoveredSelectors,
//       deterministicPage: Boolean(detection.deterministic || isListing),
//       usageContext: { userId, agentId, conversationId },
//     });
//     residualStats = residual.stats;

//     if (
//       residual.pageAttributes &&
//       Object.keys(residual.pageAttributes).length > 0
//     ) {
//       // Don't let residual related_product_urls overwrite listing product_urls
//       const residualAttrs = { ...residual.pageAttributes };
//       if (isListing && validated.attributes?.product_urls?.length) {
//         delete residualAttrs.related_product_urls;
//       }
//       sections[0].attributes = mergeAttrMaps(
//         sections[0].attributes,
//         residualAttrs,
//       );
//       validated.attributes = sections[0].attributes;
//     }

//     for (const sec of residual.sections || []) {
//       if (!sec.content || sec.content.length < 40) continue;
//       sections.push(
//         buildSection({
//           pageType: sec.pageType,
//           entity_type: sec.entity_type,
//           entity_name: sec.entity_name,
//           content: sec.content,
//           attributes: sec.attributes,
//           search_terms: sec.search_terms,
//           classification_confidence: sec.classification_confidence,
//           classification_reason: sec.classification_reason,
//           extraction_source: sec.extraction_source,
//         }),
//       );
//     }
//   } catch (err) {
//     console.warn(
//       `[extractByPageType] residual sections failed for ${url}: ${err.message}`,
//     );
//   }

//   // Combined content for storage sizing / Url contentHash of the page as a whole
//   const combinedContent = sections
//     .map((s) => s.content)
//     .filter(Boolean)
//     .join("\n\n---\n\n");

//   return {
//     content: combinedContent || validated.content,
//     webPageURL: url,
//     title: validated.title,
//     metaDescription: validated.metaDescription,
//     canonicalUrl: validated.canonicalUrl,
//     language: validated.language,
//     pageMetadata,
//     pageType: validated.pageType,
//     entity_type: validated.entity_type,
//     entity_name: validated.entity_name,
//     attributes: validated.attributes,
//     search_terms: validated.search_terms,
//     classification_confidence: validated.classification_confidence,
//     classification_reason: validated.classification_reason,
//     extraction_source: validated.extraction_source,
//     deterministic: Boolean(detection.deterministic),
//     sections,
//     residualStats,
//   };
// }

// module.exports = {
//   extractByPageType,
//   buildSection,
//   resolveProductEntityType,
//   isListingUrl,
// };



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
const { GRID_SELECTORS } = require("./extractors/listing");

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

function isListingUrl(url = "") {
  return /\/(collections?|category|categories|catalog)(\/|$)/i.test(url || "");
}

/**
 * After pageType=product, resolve PDP vs PLP.
 * Collection/catalog URLs always force listing.
 */
function resolveProductEntityType(detection, url) {
  if (isListingUrl(url)) {
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

  const $meta = cheerio.load(sourceCode);
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
    detection = resolveProductEntityType(detection, url);
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
      html: sourceCode,
      jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
      title: pageMetadata.title,
      metaDescription: pageMetadata.metaDescription,
    });
  } else if (isPdp) {
    typed = extractProductContent({
      url,
      html: sourceCode,
      jsonLdBlocks: pageMetadata.jsonLdBlocks || [],
    });
  } else if (["faq", "blog", "docs"].includes(detection.pageType)) {
    typed = extractWithReadability(url, sourceCode);
  }

  // Always have a generic fallback for chrome/homepage + thin typed extracts
  const generic = extractGenericMarkdown(url, sourceCode, chromeCache);

  let content = typed?.content || "";
  let extraction_source = typed?.extraction_source || "generic";
  let entity_name = typed?.entity_name || null;
  let attributes = typed?.attributes || {};

  if (!content || content.length < 80) {
    if (isPdp && content && content.length >= 40) {
      // PDP: keep thin structured shell; residual adds body sections.
      extraction_source = typed?.extraction_source || extraction_source;
    } else if (isListing && content && content.length >= 40) {
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
  // Re-assert listing after validation (LLM must not flip PLP → product)
  if (isListingUrl(url) || isListing) {
    validated.entity_type = "listing";
    validated.pageType = "product";
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
  });
  sections.push(primarySection);

  let faqExtracted = false;
  // Secondary FAQ only on real PDPs — not PLP/collection pages
  if (isPdp && !isListingUrl(url)) {
    const faq = extractFaqContent({
      html: sourceCode,
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
      html: sourceCode,
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
      // Don't let residual related_product_urls collide with / overwrite the
      // primary listing product_urls — but don't destroy them either. These
      // come from link-list blocks residual found *outside* the scanned
      // grid(s) (e.g. a "you may also like" section using non-standard
      // markup that GRID_SELECTORS doesn't match). Keep them under a
      // distinct key so they remain available as supplementary data.
      const residualAttrs = { ...residual.pageAttributes };
      if (
        isListing &&
        Array.isArray(residualAttrs.related_product_urls) &&
        residualAttrs.related_product_urls.length
      ) {
        residualAttrs.secondary_product_urls = residualAttrs.related_product_urls;
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
};