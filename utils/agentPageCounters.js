/**
 * Training page web-page counters.
 *
 * Total Web Pages is inventory-based (initial discovery + manual adds),
 * NOT TrainingModel row count.
 *
 * Synced/Failed are training outcomes only:
 *  - Synced = TrainingModel trainingStatus 1
 *  - Failed = TrainingModel trainingStatus 2
 */
const Agent = require("../models/Agent");
const Url = require("../models/Url");

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
 * Recompute and write `agent.pagesAdded.{total,success,failed}`.
 * Keep TrainingModel only for success/failed (not total).
 */
async function recomputeWebPageCounters(TrainingModel, userId, agentId) {
  if (!TrainingModel || !agentId) return null;

  const [pagesSuccess, pagesFailed, pagesTotal] = await Promise.all([
    TrainingModel.countDocuments({
      userId,
      agentId,
      type: 0,
      trainingStatus: 1,
    }),
    TrainingModel.countDocuments({
      userId,
      agentId,
      type: 0,
      trainingStatus: 2,
    }),
    countWebPageInventory(agentId),
  ]);

  await Agent.updateOne(
    { _id: agentId },
    {
      $set: {
        "pagesAdded.success": pagesSuccess,
        "pagesAdded.failed": pagesFailed,
        "pagesAdded.total": pagesTotal,
      },
    },
  );

  return {
    success: pagesSuccess,
    failed: pagesFailed,
    total: pagesTotal,
  };
}

module.exports = {
  countWebPageInventory,
  recomputeWebPageCounters,
};
