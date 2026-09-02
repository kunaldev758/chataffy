/**
 * Training page web-page counters.
 *
 * Total Web Pages is inventory-based (initial discovery + manual adds),
 * NOT TrainingModel row count.
 *
 * Synced/Failed/Skipped are training outcomes only:
 *  - Synced = TrainingModel trainingStatus 1
 *  - Skipped = trainingStatus 2 with a skip reason
 *  - Failed = remaining trainingStatus 2 rows
 */
const Agent = require("../models/Agent");
const Url = require("../models/Url");
const {
  skippedTrainingListClause,
  failedTrainingListClause,
} = require("../constants/trainingErrors");

async function countWebPageInventory(agentId) {
  if (!agentId) return 0;

  // discovery inventory is persisted on the agent during onboarding
  const agent = await Agent.findById(agentId).select("onboardingExtractedUrls").lean();
  const inventory = agent?.onboardingExtractedUrls;
  if (Array.isArray(inventory) && inventory.length > 0) {
    return inventory.length;
  }

  // Legacy fallback: before onboardingExtractedUrls was persisted, approximate with Url inventory.
  return Url.countDocuments({ agentId });
}

/**
 * Recompute and write `agent.pagesAdded.{total,success,failed,skipped}`.
 * Keep TrainingModel only for success/failed/skipped (not total).
 */
async function recomputeWebPageCounters(TrainingModel, userId, agentId) {
  if (!TrainingModel || !agentId) return null;

  const outcomeBase = { userId, agentId, type: 0 };
  const [pagesSuccess, pagesFailed, pagesSkipped, pagesTotal] = await Promise.all([
    TrainingModel.countDocuments({
      ...outcomeBase,
      trainingStatus: 1,
    }),
    TrainingModel.countDocuments({
      ...outcomeBase,
      ...failedTrainingListClause(),
    }),
    TrainingModel.countDocuments({
      ...outcomeBase,
      ...skippedTrainingListClause(),
    }),
    countWebPageInventory(agentId),
  ]);

  await Agent.updateOne(
    { _id: agentId },
    {
      $set: {
        "pagesAdded.success": pagesSuccess,
        "pagesAdded.failed": pagesFailed,
        "pagesAdded.skipped": pagesSkipped,
        "pagesAdded.total": pagesTotal,
      },
    },
  );

  return {
    success: pagesSuccess,
    failed: pagesFailed,
    skipped: pagesSkipped,
    total: pagesTotal,
  };
}

module.exports = {
  countWebPageInventory,
  recomputeWebPageCounters,
};
