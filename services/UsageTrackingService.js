const OpenAIUsage = require('../models/OpenAIUsageSchema');
const QdrantUsage = require('../models/qdrantUsageSchema');
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require('./aiModelService');

/**
 * Compute token costs from per-million rates on an AiModel record / resolved config.
 */
function computeTokenCosts({
  inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  inputCostPerMillion = 0,
  outputCostPerMillion = 0,
  cacheCostPerMillion = 0,
}) {
  const uncachedPromptTokens = Math.max(0, inputTokens - cacheTokens);
  const inputCost = (uncachedPromptTokens / 1_000_000) * (inputCostPerMillion || 0);
  const cacheCost = (cacheTokens / 1_000_000) * (cacheCostPerMillion || 0);
  const outputCost = (outputTokens / 1_000_000) * (outputCostPerMillion || 0);
  return {
    inputCost,
    outputCost,
    cacheCost,
    totalCost: inputCost + outputCost + cacheCost,
  };
}

/**
 * Log an OpenAI / open-source API usage record to the database.
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
      totalTokens: totalTokens || inputTokens + outputTokens,
      inputCost,
      outputCost,
      cacheCost,
      totalCost: totalCost || inputCost + outputCost + cacheCost,
    });
  } catch (err) {
    console.error('[UsageTrackingService] Failed to save OpenAI usage record:', err.message);
    return null;
  }
}

/**
 * Resolve model pricing for a category and log usage from an OpenAI-style usage object
 * ({ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details }).
 */
async function logUsageForCategory({
  category,
  userId,
  agentId = null,
  conversationId = null,
  usage = null,
  modelName = null,
  fallbackCategories = [],
}) {
  if (!userId || !usage) return null;

  const cfg = await getResolvedModelConfig(category, fallbackCategories);
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const cacheTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const costs = computeTokenCosts({
    inputTokens,
    outputTokens,
    cacheTokens,
    inputCostPerMillion: cfg.inputCost,
    outputCostPerMillion: cfg.outputCost,
    cacheCostPerMillion: cfg.cacheCost,
  });

  return logOpenAIUsage({
    userId,
    agentId,
    conversationId,
    model: modelName || cfg.model,
    type: usageTypeForCategory(category),
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens: usage.total_tokens || inputTokens + outputTokens,
    ...costs,
  });
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

async function getOpenAIUsageByType(userId, { startDate, endDate } = {}) {
  const match = {};
  if (userId) match.userId = userId;
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate)   match.createdAt.$lte = new Date(endDate);
  }

  const rows = await OpenAIUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        inputTokens:  { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cacheTokens:  { $sum: '$cacheTokens' },
        totalTokens:  { $sum: '$totalTokens' },
        inputCost:    { $sum: '$inputCost' },
        outputCost:   { $sum: '$outputCost' },
        cacheCost:    { $sum: '$cacheCost' },
        totalCost:    { $sum: '$totalCost' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const emptyType = () => ({
    inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0,
    inputCost: 0,   outputCost: 0,   cacheCost: 0,   totalCost: 0,
  });

  // Pull known types straight from the schema's own enum — this is the
  // actual field we're grouping on, so it's the correct source of truth.
  const knownTypes = OpenAIUsage.schema.path('type').enumValues;
  const byType = Object.fromEntries(knownTypes.map((t) => [t, emptyType()]));

  const totals = emptyType();

  for (const row of rows) {
    const type = row._id || 'unknown';
    byType[type] = {
      inputTokens:  row.inputTokens,
      outputTokens: row.outputTokens,
      cacheTokens:  row.cacheTokens,
      totalTokens:  row.totalTokens,
      inputCost:    row.inputCost,
      outputCost:   row.outputCost,
      cacheCost:    row.cacheCost,
      totalCost:    row.totalCost,
    };
    totals.inputTokens  += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheTokens  += row.cacheTokens;
    totals.totalTokens  += row.totalTokens;
    totals.inputCost    += row.inputCost;
    totals.outputCost   += row.outputCost;
    totals.cacheCost    += row.cacheCost;
    totals.totalCost    += row.totalCost;
  }

  return { byType, totals };
}

module.exports = {
  logOpenAIUsage,
  logUsageForCategory,
  computeTokenCosts,
  getOpenAIUsage,
  getOpenAIUsageByType,
  logQdrantUsage,
  getQdrantUsage
};
