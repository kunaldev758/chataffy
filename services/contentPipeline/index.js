const schema = require("./schema");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const { extractPageMetadata } = require("./extractPageMetadata");
const { extractByPageType } = require("./extractByPageType");
const { detectPageType, RULE_CONFIDENCE_THRESHOLD } = require("./detectPageType");
const {
  classifyPageTypeLlm,
  isPageTypeLlmEnabled,
} = require("./classifyPageTypeLlm");
const { applyValidation } = require("./validatePage");
const {
  normalizeToCommonSchema,
  hashContent,
  pageToUpsertDocuments,
} = require("./normalizeSchema");
const { upsertPageToQdrant, normalizeAndUpsertPage } = require("./upsertPageToQdrant");
const { processPageDocuments } = require("./processPageDocuments");
const urlStatus = require("./urlStatus");
const htmlCleanup = require("./htmlCleanup");
const { scoreQuality, QUALITY_THRESHOLD } = require("./qualityScore");
const { checkCanonicalDuplicate } = require("./canonicalDedupe");
const { extractProductContent } = require("./extractors/product");
const { extractListingContent } = require("./extractors/listing");
const { extractWithReadability } = require("./extractors/contentReadability");
const { extractFaqContent } = require("./extractors/faq");
const {
  structureAwareChunk,
  splitByHeadings,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
} = require("./chunking");
const { buildContextPrefix, applyEmbeddingPrefix } = require("./contextPrefix");
const {
  processResidualSections,
  markCoveredRegions,
  markPrimaryCoveredRegions,
  findCandidateSections,
  classifySectionByRules,
  extractLinkListAttributes,
  SECTION_RULE_THRESHOLD,
} = require("./residualSections");
const { classifySectionsLlm } = require("./classifySectionsLlm");

module.exports = {
  ...schema,
  extractGenericMarkdown,
  extractPageMetadata,
  extractByPageType,
  detectPageType,
  RULE_CONFIDENCE_THRESHOLD,
  classifyPageTypeLlm,
  isPageTypeLlmEnabled,
  applyValidation,
  normalizeToCommonSchema,
  hashContent,
  pageToUpsertDocuments,
  upsertPageToQdrant,
  normalizeAndUpsertPage,
  processPageDocuments,
  ...urlStatus,
  htmlCleanup,
  scoreQuality,
  QUALITY_THRESHOLD,
  checkCanonicalDuplicate,
  extractProductContent,
  extractListingContent,
  extractWithReadability,
  extractFaqContent,
  structureAwareChunk,
  splitByHeadings,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
  buildContextPrefix,
  applyEmbeddingPrefix,
  processResidualSections,
  markCoveredRegions,
  markPrimaryCoveredRegions,
  findCandidateSections,
  classifySectionByRules,
  extractLinkListAttributes,
  SECTION_RULE_THRESHOLD,
  classifySectionsLlm,
};
