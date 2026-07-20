const cheerio = require("cheerio");
const { extractPageMetadata } = require("./extractPageMetadata");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const { detectPageType } = require("./detectPageType");
const { classifyPageTypeLlm } = require("./classifyPageTypeLlm");
const { applyValidation } = require("./validatePage");
const { extractProductContent } = require("./extractors/product");
const { extractWithReadability } = require("./extractors/contentReadability");

/**
 * Phase 3 orchestrator:
 * metadata → rule page-type → optional LLM → typed extraction → validation.
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
    // Keep structured product head, append richer body if much longer
    content = `${content}\n\n---\n\n${generic.content}`.replace(/\n{3,}/g, "\n\n");
    extraction_source = `${extraction_source}+generic_body`;
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

  return {
    content: validated.content,
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
  };
}

module.exports = {
  extractByPageType,
};
