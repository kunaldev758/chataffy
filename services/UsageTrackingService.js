const OpenAIUsage = require('../models/OpenAIUsageSchema');
const QdrantUsage = require('../models/qdrantUsageSchema');
const { getModelForCategory } = require('./aiModelService');

/**
 * Log an OpenAI API usage record to the database.
 * Silently no-ops (with a warning) if required fields are missing, so callers
 * are never crashed by a logging failure.
 */
async function logOpenAIUsage({
  userId,
  agentId,
  conversationId,
  model,
  type,
  inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  totalTokens = 0,
  inputCost = 0,
  outputCost = 0,
  cacheCost = 0,
  totalCost = 0,
}) {
  // userId is required by the schema – skip rather than throw
  if (!userId) {
    console.warn('[UsageTrackingService] logOpenAIUsage skipped: userId is required but was not provided.');
    return null;
  }

  try {
    return await OpenAIUsage.create({
      userId,
      agentId,
      conversationId,
      model,
      type,
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens,
      inputCost,
      outputCost,
      cacheCost,
      totalCost,
    });
  } catch (err) {
    console.error('[UsageTrackingService] Failed to save OpenAI usage record:', err.message);
    return null;
  }
}

async function getOpenAIUsage(userId, { startDate, endDate } = {}) {
  const query = {};
  if (userId) query.userId = userId;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const result = await OpenAIUsage.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalInputTokens: { $sum: '$inputTokens' },
        totalOutputTokens: { $sum: '$outputTokens' },
        totalCacheTokens: { $sum: '$cacheTokens' },
        totalTokens: { $sum: '$totalTokens' },
        totalInputCost: { $sum: '$inputCost' },
        totalOutputCost: { $sum: '$outputCost' },
        totalCacheCost: { $sum: '$cacheCost' },
        totalCost: { $sum: '$totalCost' },
        totalRequests: { $sum: 1 },
      }
    }
  ]);

  return result[0] || {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheTokens: 0,
    totalTokens: 0,
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCacheCost: 0,
    totalCost: 0,
    totalRequests: 0,
  };
}


async function logQdrantUsage({ userId, vectorsAdded, vectorsDeleted, storageMB, collectionName, estimatedCost }) {
  if (!collectionName) throw new Error('Missing collectionName for Qdrant usage log.');
  try {
    return await QdrantUsage.create({
      userId,
      vectorsAdded,
      vectorsDeleted,
      storageMB,
      collectionName,
      estimatedCost,
      date: new Date()
    });
  } catch (err) {
    console.error('[UsageTrackingService] Failed to save Qdrant usage record:', err.message);
    return null;
  }
}


async function getQdrantUsage(collectionName, { startDate, endDate } = {}) {
  const query = {};
  if (collectionName) query.collectionName = collectionName;
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

const result = await QdrantUsage.aggregate([
  { $match: query },
  {
    $group: {
      _id: null,
      totalVectorsAdded: { $sum: '$vectorsAdded' },
      totalVectorsDeleted: { $sum: '$vectorsDeleted' },
      totalApiCalls: { $sum: '$apiCalls' },
      totalEstimatedCostRequests: { $sum: '$estimatedCost.requests' },
      totalEstimatedCostStorage: { $sum: '$estimatedCost.storage' }
    }
  }
]);

  return result[0] || {
    totalVectorsAdded: 0,
    totalVectorsDeleted: 0,
    totalApiCalls: 0,
    totalEstimatedCostRequests:0,
    totalEstimatedCostStorage:0,
  };
}

module.exports = {
  logOpenAIUsage,
  getOpenAIUsage,
  logQdrantUsage,
  getQdrantUsage
};
