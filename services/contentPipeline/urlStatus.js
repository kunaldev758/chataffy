const Url = require("../../models/Url");
const { URL_PIPELINE_STATUS } = require("./schema");

async function updateUrlPipeline(url, userId, agentId, patch) {
  if (!url || !userId || !agentId) return;
  const $set = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) $set[key] = value;
  }
  if (!$set.lastCheckedAt) $set.lastCheckedAt = new Date();

  return Url.updateOne({ url, userId, agentId }, { $set });
}

async function markUrlFetched(url, userId, agentId) {
  return updateUrlPipeline(url, userId, agentId, {
    status: URL_PIPELINE_STATUS.FETCHED,
    failureReason: null,
    error: null,
  });
}

async function markUrlProcessed(url, userId, agentId, fields = {}) {
  return updateUrlPipeline(url, userId, agentId, {
    trainStatus: 1,
    status: URL_PIPELINE_STATUS.PROCESSED,
    error: null,
    failureReason: null,
    contentHash: fields.contentHash ?? null,
    pageType: fields.pageType ?? "generic",
    canonicalUrl: fields.canonicalUrl ?? null,
    language: fields.language ?? null,
    qualityScore:
      typeof fields.qualityScore === "number" ? fields.qualityScore : null,
    lastCrawledAt: new Date(),
  });
}

/** Hash unchanged — keep vectors, only bump lastCheckedAt. */
async function markUrlUnchanged(url, userId, agentId, fields = {}) {
  return updateUrlPipeline(url, userId, agentId, {
    trainStatus: 1,
    status: URL_PIPELINE_STATUS.PROCESSED,
    error: null,
    failureReason: null,
    contentHash: fields.contentHash ?? undefined,
    pageType: fields.pageType ?? undefined,
    canonicalUrl: fields.canonicalUrl ?? undefined,
    language: fields.language ?? undefined,
    qualityScore:
      typeof fields.qualityScore === "number" ? fields.qualityScore : undefined,
  });
}

async function markUrlFailed(url, userId, agentId, reason) {
  const result = await updateUrlPipeline(url, userId, agentId, {
    trainStatus: 2,
    status: URL_PIPELINE_STATUS.FAILED,
    error: reason || "Failed to train",
    failureReason: reason || "Failed to train",
  });

  console.error("[url-training:failed]", {
    agentId,
    url,
    stage: "url_status",
    reason: reason || "Failed to train",
    matchedUrlRecord: (result?.matchedCount || 0) > 0,
  });
  return result;
}

async function markUrlSkipped(url, userId, agentId, reason, fields = {}) {
  const result = await updateUrlPipeline(url, userId, agentId, {
    status: URL_PIPELINE_STATUS.SKIPPED,
    failureReason: reason || "skipped",
    error: null,
    canonicalUrl: fields.canonicalUrl ?? undefined,
    language: fields.language ?? undefined,
    qualityScore:
      typeof fields.qualityScore === "number" ? fields.qualityScore : undefined,
    pageType: fields.pageType ?? undefined,
    contentHash: fields.contentHash ?? undefined,
  });

  console.warn("[url-training:skipped]", {
    agentId,
    url,
    stage: "url_status",
    reason: reason || "skipped",
    canonicalUrl: fields.canonicalUrl ?? null,
    qualityScore:
      typeof fields.qualityScore === "number" ? fields.qualityScore : null,
    pageType: fields.pageType ?? null,
    matchedUrlRecord: (result?.matchedCount || 0) > 0,
  });
  return result;
}

async function markUrlsQueued(urls, userId, agentId) {
  if (!Array.isArray(urls) || !urls.length || !userId || !agentId) return;
  await Url.updateMany(
    { userId, agentId, url: { $in: urls } },
    { $set: { status: URL_PIPELINE_STATUS.QUEUED, lastCheckedAt: new Date() } },
  );
}

module.exports = {
  updateUrlPipeline,
  markUrlFetched,
  markUrlProcessed,
  markUrlUnchanged,
  markUrlFailed,
  markUrlSkipped,
  markUrlsQueued,
};
