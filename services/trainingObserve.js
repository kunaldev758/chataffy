const TrainingObserve = require("../models/TrainingObserve");

/**
 * Persist a training run summary keyed by BullMQ job id (trainingRunId).
 * Failures are logged but never thrown so training jobs are not blocked.
 */
async function saveTrainingObserve({
  trainingRunId,
  userId,
  agentId,
  status,
  startedAt,
  totalChunks = 0,
  failedReason = null,
}) {
  if (!trainingRunId || !userId || !agentId || !startedAt) {
    return null;
  }

  const finishedAt = new Date();
  const durationMs = Math.max(
    0,
    finishedAt.getTime() - new Date(startedAt).getTime(),
  );

  try {
    return await TrainingObserve.findOneAndUpdate(
      { trainingRunId },
      {
        $set: {
          trainingRunId,
          userId,
          agentId,
          status,
          failedReason:
            status === "failed" ? failedReason || "Unknown training failure" : null,
          startedAt: new Date(startedAt),
          finishedAt,
          totalChunks: totalChunks ?? 0,
          durationMs,
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error("[TrainingObserve] Failed to save training observe:", err.message);
    return null;
  }
}

module.exports = {
  saveTrainingObserve,
};
