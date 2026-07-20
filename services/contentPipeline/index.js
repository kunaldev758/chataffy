const schema = require("./schema");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const { extractPageMetadata } = require("./extractPageMetadata");
const {
  normalizeToCommonSchema,
  hashContent,
  pageToUpsertDocuments,
} = require("./normalizeSchema");
const { upsertPageToQdrant, normalizeAndUpsertPage } = require("./upsertPageToQdrant");
const { processPageDocuments } = require("./processPageDocuments");
const urlStatus = require("./urlStatus");
const htmlCleanup = require("./htmlCleanup");

module.exports = {
  ...schema,
  extractGenericMarkdown,
  extractPageMetadata,
  normalizeToCommonSchema,
  hashContent,
  pageToUpsertDocuments,
  upsertPageToQdrant,
  normalizeAndUpsertPage,
  processPageDocuments,
  ...urlStatus,
  htmlCleanup,
};
