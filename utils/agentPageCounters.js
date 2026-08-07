/**
 * Align agent.pagesAdded with actual type-0 training list rows.
 * Source of truth for the Training page "Total Web Pages" inventory count.
 */
async function recomputeWebPageCounters(TrainingModel, userId, agentId) {
  if (!TrainingModel || !agentId) return null;
  const Agent = require("../models/Agent");

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
    TrainingModel.countDocuments({ userId, agentId, type: 0 }),
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
  recomputeWebPageCounters,
};
