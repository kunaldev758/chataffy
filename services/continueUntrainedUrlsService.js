const Client = require("../models/Client");
const Agent = require("../models/Agent");
const Url = require("../models/Url");
const PlanService = require("./PlanService");
const appEvents = require("../events");
const { urlProcessingQueue } = require("./jobService");
const { filterAndDedupeWebUrls } = require("../utils/webUrlUtils");

/**
 * Queue scraping/training for remaining Url docs with trainStatus 0 for one agent.
 * @returns {{ queued: boolean, urlCount: number, skippedReason?: string }}
 */
async function continueUntrainedUrlsForAgent(userId, agentId) {
  if (!userId || !agentId) {
    return { queued: false, urlCount: 0, skippedReason: "missing_ids" };
  }

  const client = await Client.findOne({ userId });
  if (!client) {
    return { queued: false, urlCount: 0, skippedReason: "client_not_found" };
  }

  if (client.upgradePlanStatus?.storageLimitExceeded === true) {
    return { queued: false, urlCount: 0, skippedReason: "storage_limit_exceeded" };
  }

  const agent = await Agent.findOne({ _id: agentId, userId, isDeleted: { $ne: true } });
  if (!agent) {
    return { queued: false, urlCount: 0, skippedReason: "agent_not_found" };
  }

  if (agent.dataTrainingStatus === 1) {
    return { queued: false, urlCount: 0, skippedReason: "already_training" };
  }

  const qdrantIndexName =
    client?.plan == "free" ? agent?.qdrantIndexName : agent?.qdrantIndexNamePaid;

  if (!qdrantIndexName) {
    return { queued: false, urlCount: 0, skippedReason: "no_qdrant_index" };
  }

  let remainingUrls = filterAndDedupeWebUrls(
    await Url.distinct("url", {
      agentId,
      trainStatus: 0,
    }),
  );

  // Skip pages already present in training list (avoids duplicates if Url.trainStatus was never set to 1)
  if (remainingUrls.length > 0) {
    const TrainingModel = await PlanService.getTrainingModel(userId);
    const alreadyTrained = await TrainingModel.find({
      userId: userId?.toString?.() ?? String(userId),
      agentId,
      type: 0,
      trainingStatus: 1,
      "webPage.url": { $in: remainingUrls },
    })
      .select("webPage.url")
      .lean();
    const trainedSet = new Set(
      alreadyTrained.map((e) => e.webPage?.url).filter(Boolean),
    );
    if (trainedSet.size > 0) {
      remainingUrls = remainingUrls.filter((u) => !trainedSet.has(u));
    }
  }

  if (remainingUrls.length <= 0) {
    return { queued: false, urlCount: 0, skippedReason: "no_urls" };
  }

  const plan = await PlanService.getUserPlan(userId);
  const scrapingStartTime = new Date();

  await Agent.updateOne(
    { _id: agentId },
    {
      $set: {
        dataTrainingStatus: 1,
        scrapingStartTime,
      },
    },
  );

  appEvents.emit("userEvent", agentId, "training-event", {
    agent: await Agent.findOne({ _id: agentId }),
    client: await Client.findOne({ userId }),
    message: "Resuming training for pages left after storage limit.",
  });

  await urlProcessingQueue.add("processSingleUrl", {
    urls: remainingUrls,
    userId,
    qdrantIndexName,
    plan,
    agentId,
    startTime: scrapingStartTime.getTime(),
    totalUrls: remainingUrls.length,
  });

  return { queued: true, urlCount: remainingUrls.length };
}

/**
 * For every agent of a user that still has untrained URLs, queue continue scraping.
 * Used after custom storage limit is increased.
 */
async function continueUntrainedUrlsForUser(userId) {
  if (!userId) {
    return { agentsQueued: 0, totalUrls: 0, results: [] };
  }

  const agents = await Agent.find({
    userId,
    isDeleted: { $ne: true },
  })
    .select("_id")
    .lean();

  const results = [];
  let agentsQueued = 0;
  let totalUrls = 0;

  for (const agent of agents) {
    const agentId = agent._id;
    try {
      const hasPending = await Url.exists({ agentId, trainStatus: 0 });
      if (!hasPending) continue;

      const result = await continueUntrainedUrlsForAgent(userId, agentId);
      results.push({ agentId: String(agentId), ...result });
      if (result.queued) {
        agentsQueued += 1;
        totalUrls += result.urlCount;
      }
    } catch (error) {
      console.error(
        `[continueUntrainedUrls] Failed for agent ${agentId}:`,
        error?.message || error,
      );
      results.push({
        agentId: String(agentId),
        queued: false,
        urlCount: 0,
        skippedReason: error?.message || "error",
      });
    }
  }

  return { agentsQueued, totalUrls, results };
}

module.exports = {
  continueUntrainedUrlsForAgent,
  continueUntrainedUrlsForUser,
};
