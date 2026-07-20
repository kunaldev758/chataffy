const Url = require("../../models/Url");
const { URL_PIPELINE_STATUS } = require("./schema");

async function updateUrlPipeline(url, agentId, patch) {
  if (!url || !agentId) return;
  const $set = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) $set[key] = value;
  }
  if (!$set.lastCheckedAt) $set.lastCheckedAt = new Date();

  await Url.updateOne({ url, agentId }, { $set });
}

async function markUrlFetched(url, agentId) {
  return updateUrlPipeline(url, agentId, {
    status: URL_PIPELINE_STATUS.FETCHED,
    failureReason: null,
    error: null,
  });
}

async function markUrlProcessed(url, agentId, fields = {}) {
  return updateUrlPipeline(url, agentId, {
    trainStatus: 1,
    status: URL_PIPELINE_STATUS.PROCESSED,
    error: null,
    failureReason: null,
    contentHash: fields.contentHash ?? null,
    pageType: fields.pageType ?? "generic",
    canonicalUrl: fields.canonicalUrl ?? null,
    language: fields.language ?? null,
    lastCrawledAt: new Date(),
  });
}

async function markUrlFailed(url, agentId, reason) {
  return updateUrlPipeline(url, agentId, {
    trainStatus: 2,
    status: URL_PIPELINE_STATUS.FAILED,
    error: reason || "Failed to train",
    failureReason: reason || "Failed to train",
  });
}

async function markUrlSkipped(url, agentId, reason) {
  return updateUrlPipeline(url, agentId, {
    status: URL_PIPELINE_STATUS.SKIPPED,
    failureReason: reason || "skipped",
  });
}

async function markUrlsQueued(urls, agentId) {
  if (!Array.isArray(urls) || !urls.length || !agentId) return;
  await Url.updateMany(
    { agentId, url: { $in: urls } },
    { $set: { status: URL_PIPELINE_STATUS.QUEUED, lastCheckedAt: new Date() } },
  );
}

module.exports = {
  updateUrlPipeline,
  markUrlFetched,
  markUrlProcessed,
  markUrlFailed,
  markUrlSkipped,
  markUrlsQueued,
};
