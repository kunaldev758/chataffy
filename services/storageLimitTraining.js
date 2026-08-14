const Agent = require("../models/Agent");
const Client = require("../models/Client");
const Url = require("../models/Url");
const {
  STORAGE_LIMIT_ERROR_TYPE,
  STORAGE_LIMIT_ERROR,
} = require("../constants/trainingErrors");

function canMarkAsStorageLimit(row) {
  if (!row) return true;
  if (row.trainingStatus === 1) return false;
  if (row.trainingStatus === 2) {
    return row.errorType === STORAGE_LIMIT_ERROR_TYPE;
  }
  return row.trainingStatus === 0 || row.trainingStatus == null;
}

/**
 * Mark unfinished job URLs as STORAGE_LIMIT failures in one bulk write.
 * Does not overwrite successful rows or unrelated failures.
 */
async function markUnfinishedUrlsForStorageLimit({
  TrainingModel,
  userId,
  agentId,
  unfinishedUrls,
}) {
  const urls = [...new Set((unfinishedUrls || []).filter(Boolean))];
  if (!urls.length || !TrainingModel || !userId || !agentId) return 0;

  const existingRows = await TrainingModel.find({
    userId,
    agentId,
    type: 0,
    "webPage.url": { $in: urls },
  })
    .select("_id webPage.url trainingStatus errorType")
    .sort({ createdAt: 1 })
    .lean();

  const rowsByUrl = new Map();
  for (const row of existingRows) {
    const url = row.webPage?.url;
    if (!url || rowsByUrl.has(url)) continue;
    rowsByUrl.set(url, row);
  }

  const now = new Date();
  const ops = [];
  const markedUrls = [];

  for (const url of urls) {
    const row = rowsByUrl.get(url);
    if (row && !canMarkAsStorageLimit(row)) continue;

    const setFields = {
      userId,
      agentId,
      type: 0,
      title: url,
      content: "",
      dataSize: 0,
      trainingStatus: 2,
      errorType: STORAGE_LIMIT_ERROR_TYPE,
      error: STORAGE_LIMIT_ERROR,
      "webPage.url": url,
      chunkCount: 0,
      lastEdit: now,
    };

    if (row) {
      ops.push({
        updateOne: {
          filter: {
            _id: row._id,
            trainingStatus: { $ne: 1 },
            $or: [
              { trainingStatus: { $in: [0] } },
              { trainingStatus: { $exists: false } },
              { errorType: STORAGE_LIMIT_ERROR_TYPE },
            ],
          },
          update: { $set: setFields },
        },
      });
    } else {
      ops.push({
        insertOne: {
          document: {
            userId,
            agentId,
            type: 0,
            title: url,
            content: "",
            dataSize: 0,
            trainingStatus: 2,
            errorType: STORAGE_LIMIT_ERROR_TYPE,
            error: STORAGE_LIMIT_ERROR,
            webPage: { url },
            chunkCount: 0,
            lastEdit: now,
            createdAt: now,
          },
        },
      });
    }
    markedUrls.push(url);
  }

  if (ops.length > 0) {
    await TrainingModel.bulkWrite(ops, { ordered: false });
  }

  if (markedUrls.length > 0) {
    await Url.updateMany(
      { userId, agentId, url: { $in: markedUrls } },
      {
        $set: {
          trainStatus: 2,
          status: "failed",
          error: STORAGE_LIMIT_ERROR,
          failureReason: STORAGE_LIMIT_ERROR,
          lastCheckedAt: now,
        },
      },
    );
  }

  const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
  await recomputeWebPageCounters(TrainingModel, userId, agentId);

  console.log(
    `[storageLimit] marked ${markedUrls.length} unfinished URL(s) as ${STORAGE_LIMIT_ERROR_TYPE} for agent ${agentId}`,
  );
  return markedUrls.length;
}

async function queueRetrainForStorageLimitFailures(userId) {
  if (!userId) return { queued: 0 };

  const PlanService = require("./PlanService");
  const { retrainTrainingDataQueue } = require("./jobService");
  const appEvents = require("../events");
  const { buildTrainingProgressPayload } = require("../utils/trainingProgress");

  const TrainingModel = await PlanService.getTrainingModel(userId);
  const plan = await PlanService.getUserPlan(userId);
  const client = await Client.findOne({ userId });
  if (!client || !TrainingModel) return { queued: 0 };

  const TrainingModelName =
    plan?.name === "free" ? "TrainingListFreeUsers" : "OpenaiTrainingList";

  const agents = await Agent.find({
    userId,
    isDeleted: { $ne: true },
  })
    .select("_id qdrantIndexName qdrantIndexNamePaid dataTrainingStatus")
    .lean();

  let queued = 0;
  for (const agent of agents) {
    if (agent.dataTrainingStatus === 1) continue;

    const entries = await TrainingModel.find({
      userId: String(userId),
      agentId: agent._id,
      type: 0,
      trainingStatus: 2,
      errorType: STORAGE_LIMIT_ERROR_TYPE,
      "webPage.url": { $nin: [null, ""] },
    }).lean();

    if (!entries.length) continue;

    const qdrantIndexName =
      client.plan === "free"
        ? agent.qdrantIndexName
        : agent.qdrantIndexNamePaid;
    if (!qdrantIndexName) continue;

    const scrapingStartTime = new Date();
    const claimedAgent = await Agent.findOneAndUpdate(
      { _id: agent._id, dataTrainingStatus: { $ne: 1 } },
      {
        $set: {
          dataTrainingStatus: 1,
          scrapingStartTime,
        },
      },
      { new: true },
    );
    if (!claimedAgent) continue;

    try {
      await retrainTrainingDataQueue.add("retrainTrainingData", {
        entries,
        userId: String(userId),
        agentId: String(agent._id),
        qdrantIndexName,
        TrainingModelName,
        startTime: scrapingStartTime.getTime(),
        totalEntries: entries.length,
      });
      queued += 1;

      appEvents.emit("userEvent", agent._id, "training-event", {
        agent: claimedAgent,
        scrapingProgress: buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "scraping",
          processed: 0,
          total: entries.length,
          isProcessing: true,
        }),
      });
    } catch (queueError) {
      await Agent.updateOne(
        { _id: agent._id },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );
      console.error(
        `[storageLimit] failed to queue retrain for agent ${agent._id}:`,
        queueError,
      );
    }
  }

  if (queued > 0) {
    console.log(
      `[storageLimit] queued retrain for ${queued} agent(s) after storage increase user=${userId}`,
    );
  }
  return { queued };
}

module.exports = {
  markUnfinishedUrlsForStorageLimit,
  queueRetrainForStorageLimitFailures,
};
