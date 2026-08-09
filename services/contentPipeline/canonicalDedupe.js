const Url = require("../../models/Url");
const {
  normalizeWebUrl,
  canonicalUrlKey,
} = require("../../utils/webUrlUtils");

/**
 * Phase 2: if page declares a canonical URL that is a *different* page already
 * stored for this agent, skip embedding this URL (duplicate of canonical).
 *
 * @returns {{ isDuplicate: boolean, duplicateOf?: string, reason?: string }}
 */
async function checkCanonicalDuplicate({
  userId,
  agentId,
  pageUrl,
  canonicalUrl,
  TrainingModel,
  /** In-batch set of canonicalUrlKey values already accepted this run */
  seenCanonicalKeys = null,
}) {
  if (!userId || !agentId || !pageUrl || !TrainingModel) {
    return { isDuplicate: false };
  }

  const hasCompletedTrainingRow = async (url) =>
    !!(await TrainingModel.exists({
      userId,
      agentId,
      type: 0,
      "webPage.url": url,
      trainingStatus: 1,
    }));

  let pageKey;
  try {
    pageKey = canonicalUrlKey(normalizeWebUrl(pageUrl));
  } catch {
    return { isDuplicate: false };
  }

  let canonKey = null;
  let canonNormalized = null;
  if (canonicalUrl) {
    try {
      canonNormalized = normalizeWebUrl(canonicalUrl);
      canonKey = canonicalUrlKey(canonNormalized);
    } catch {
      canonKey = null;
    }
  }

  // Self-canonical (or missing) — not a cross-URL duplicate
  if (!canonKey || canonKey === pageKey) {
    if (seenCanonicalKeys) {
      if (seenCanonicalKeys.has(pageKey)) {
        return {
          isDuplicate: true,
          duplicateOf: pageUrl,
          reason: "duplicate_in_batch",
        };
      }
      seenCanonicalKeys.add(pageKey);
    }
    return { isDuplicate: false };
  }

  // Another URL in this batch already owns this canonical
  if (seenCanonicalKeys?.has(canonKey)) {
    return {
      isDuplicate: true,
      duplicateOf: canonNormalized,
      reason: "canonical_already_in_batch",
    };
  }

  // Only treat a stored canonical target as a duplicate when both pipeline
  // state and the UI-facing training collection confirm successful training.
  const byUrl = await Url.findOne({
    userId,
    agentId,
    url: canonNormalized,
    trainStatus: 1,
    status: "processed",
  })
    .select("url trainStatus contentHash status")
    .lean();

  if (
    byUrl &&
    byUrl.url !== pageUrl &&
    (await hasCompletedTrainingRow(byUrl.url))
  ) {
    seenCanonicalKeys?.add(canonKey);
    return {
      isDuplicate: true,
      duplicateOf: byUrl.url,
      reason: "canonical_url_already_stored",
    };
  }

  // Another successfully trained page already resolved to this canonical.
  const byCanonical = await Url.findOne({
    userId,
    agentId,
    canonicalUrl: canonNormalized,
    url: { $ne: pageUrl },
    trainStatus: 1,
    status: "processed",
  })
    .select("url")
    .lean();

  if (
    byCanonical &&
    (await hasCompletedTrainingRow(byCanonical.url))
  ) {
    seenCanonicalKeys?.add(canonKey);
    return {
      isDuplicate: true,
      duplicateOf: byCanonical.url,
      reason: "canonical_claimed_by_other_url",
    };
  }

  // Reserve both page and canonical keys for this batch
  if (seenCanonicalKeys) {
    seenCanonicalKeys.add(pageKey);
    seenCanonicalKeys.add(canonKey);
  }

  return { isDuplicate: false };
}

module.exports = {
  checkCanonicalDuplicate,
};
