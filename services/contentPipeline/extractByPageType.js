const cheerio = require("cheerio");
const { extractPageMetadata } = require("./extractPageMetadata");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const {
  detectPageType,
} = require("./detectPageType");
const { classifyPageTypeLlm } = require("./classifyPageTypeLlm");
const { applyValidation } = require("./validatePage");
const { extractProductContent } = require("./extractors/product");
const { extractWithReadability } = require("./extractors/contentReadability");
const { extractFaqContent } = require("./extractors/faq");

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

/**
 * Phase 3 orchestrator:
 * metadata → rule page-type → optional LLM → typed extraction →
 * optional secondary FAQ section on product pages → validation.
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

  // 2) LLM only when rules are ambiguous
  let llmResult = null;
  if (detection.needsLlm) {
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
  }

  // 3) Page-type specific extraction
  let typed = null;
  if (detection.pageType === "product") {
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
    content = generic.content;
    extraction_source =
      typed && typed.content ? `${typed.extraction_source}+generic` : "generic";
    if (!entity_name && detection.pageType !== "product") {
      entity_name = generic.title || null;
    }
  } else if (
    detection.pageType === "product" &&
    generic.content &&
    generic.content.length > content.length * 1.5
  ) {
    // Keep structured product head; drop trailing FAQ from body (indexed separately)
    const bodyWithoutFaq = generic.content
      .replace(
        /\n+#{1,3}\s*(frequently asked questions|faqs?)\b[\s\S]*$/i,
        "",
      )
      .trim();
    if (bodyWithoutFaq.length > content.length) {
      content = `${content}\n\n---\n\n${bodyWithoutFaq}`.replace(
        /\n{3,}/g,
        "\n\n",
      );
      extraction_source = `${extraction_source}+generic_body`;
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

  // 5) Multi-section: product pages can also yield a FAQ section
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

  // Product PDPs often embed FAQPage schema — index FAQ as its own section
  if (validated.pageType === "product") {
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
    sections,
  };
}

module.exports = {
  extractByPageType,
  buildSection,
};
