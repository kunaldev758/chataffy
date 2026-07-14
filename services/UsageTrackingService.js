const mongoose = require('mongoose');
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

function emptyUsageTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
    totalRequests: 0,
  };
}

/** Types that count toward chat conversation usage (not website-training embeddings). */
const CHAT_USAGE_TYPES = ['chat', 'brief-chat', 'intent', 'open-source'];
const CONVERSATION_USAGE_TYPES = [...CHAT_USAGE_TYPES, 'embedding'];

function isChatUsageType(type) {
  return CHAT_USAGE_TYPES.includes(type);
}

function toObjectIdOrValue(id) {
  if (id == null || id === '') return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (mongoose.Types.ObjectId.isValid(id)) {
    return new mongoose.Types.ObjectId(String(id));
  }
  return id;
}

/**
 * Aggregate OpenAI usage grouped by agentId for a client user.
 * Returns overall totals per agent plus embedding-only (website training) usage.
 */
async function getOpenAIUsageGroupedByAgent(userId, { startDate, endDate } = {}) {
  const match = {};
  if (userId) match.userId = toObjectIdOrValue(userId);
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const rows = await OpenAIUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: { agentId: '$agentId', type: '$type' },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cacheTokens: { $sum: '$cacheTokens' },
        totalTokens: { $sum: '$totalTokens' },
        inputCost: { $sum: '$inputCost' },
        outputCost: { $sum: '$outputCost' },
        cacheCost: { $sum: '$cacheCost' },
        totalCost: { $sum: '$totalCost' },
        totalRequests: { $sum: 1 },
      },
    },
  ]);

  const byAgent = {};
  const totals = emptyUsageTotals();

  const ensureAgent = (key) => {
    if (!byAgent[key]) {
      byAgent[key] = {
        openAIUsage: emptyUsageTotals(),
        embeddingUsage: emptyUsageTotals(),
      };
    }
    return byAgent[key];
  };

  const addInto = (target, usage) => {
    target.inputTokens += usage.inputTokens;
    target.outputTokens += usage.outputTokens;
    target.cacheTokens += usage.cacheTokens;
    target.totalTokens += usage.totalTokens;
    target.inputCost += usage.inputCost;
    target.outputCost += usage.outputCost;
    target.cacheCost += usage.cacheCost;
    target.totalCost += usage.totalCost;
    target.totalRequests += usage.totalRequests;
  };

  for (const row of rows) {
    const key = row._id?.agentId ? String(row._id.agentId) : 'unknown';
    const type = row._id?.type || 'unknown';
    const usage = {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheTokens: row.cacheTokens || 0,
      totalTokens: row.totalTokens || 0,
      inputCost: row.inputCost || 0,
      outputCost: row.outputCost || 0,
      cacheCost: row.cacheCost || 0,
      totalCost: row.totalCost || 0,
      totalRequests: row.totalRequests || 0,
    };
    const agentBucket = ensureAgent(key);
    addInto(totals, usage);
    if (type === 'embedding') {
      addInto(agentBucket.embeddingUsage, usage);
    } else {
      // Chat / brief-chat / intent / open-source — keep separate from training embeddings
      addInto(agentBucket.openAIUsage, usage);
    }
  }

  return { byAgent, totals };
}

/**
 * Aggregate OpenAI usage per conversation for one agent (chatbot).
 * Returns chat metrics plus embedding input tokens/cost when logged with that conversationId.
 * Chat includes brief-chat / intent / open-source (same thread cost as premium "chat").
 */
async function getOpenAIUsageGroupedByConversation(
  userId,
  agentId,
  { startDate, endDate } = {}
) {
  const match = {
    conversationId: { $ne: null, $exists: true },
    type: { $in: CONVERSATION_USAGE_TYPES },
  };
  if (userId) match.userId = toObjectIdOrValue(userId);
  if (agentId) match.agentId = toObjectIdOrValue(agentId);
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const rows = await OpenAIUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: { conversationId: '$conversationId', type: '$type' },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cacheTokens: { $sum: '$cacheTokens' },
        totalTokens: { $sum: '$totalTokens' },
        inputCost: { $sum: '$inputCost' },
        outputCost: { $sum: '$outputCost' },
        cacheCost: { $sum: '$cacheCost' },
        totalCost: { $sum: '$totalCost' },
        totalRequests: { $sum: 1 },
      },
    },
  ]);

  const byConversation = new Map();

  const ensureConv = (id) => {
    const key = String(id);
    if (!byConversation.has(key)) {
      byConversation.set(key, {
        conversationId: key,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        inputCost: 0,
        outputCost: 0,
        cacheCost: 0,
        totalCost: 0,
        totalRequests: 0,
        embeddingInputTokens: 0,
        embeddingInputCost: 0,
        embeddingTotalTokens: 0,
        embeddingTotalRequests: 0,
      });
    }
    return byConversation.get(key);
  };

  for (const row of rows) {
    const convId = row._id?.conversationId;
    if (!convId) continue;
    const type = row._id?.type;
    const conv = ensureConv(convId);

    if (type === 'embedding') {
      conv.embeddingInputTokens += row.inputTokens || 0;
      conv.embeddingInputCost += row.inputCost || 0;
      conv.embeddingTotalTokens += row.totalTokens || 0;
      conv.embeddingTotalRequests += row.totalRequests || 0;
    } else if (isChatUsageType(type)) {
      conv.inputTokens += row.inputTokens || 0;
      conv.outputTokens += row.outputTokens || 0;
      conv.cacheTokens += row.cacheTokens || 0;
      conv.totalTokens += row.totalTokens || 0;
      conv.inputCost += row.inputCost || 0;
      conv.outputCost += row.outputCost || 0;
      conv.cacheCost += row.cacheCost || 0;
      conv.totalCost += row.totalCost || 0;
      conv.totalRequests += row.totalRequests || 0;
    }
  }

  const conversations = Array.from(byConversation.values()).sort(
    (a, b) => (b.totalCost + b.embeddingInputCost) - (a.totalCost + a.embeddingInputCost)
  );

  const totals = {
    ...emptyUsageTotals(),
    embeddingInputTokens: 0,
    embeddingInputCost: 0,
  };
  for (const c of conversations) {
    totals.inputTokens += c.inputTokens;
    totals.outputTokens += c.outputTokens;
    totals.cacheTokens += c.cacheTokens;
    totals.totalTokens += c.totalTokens;
    totals.inputCost += c.inputCost;
    totals.outputCost += c.outputCost;
    totals.cacheCost += c.cacheCost;
    totals.totalCost += c.totalCost;
    totals.totalRequests += c.totalRequests;
    totals.embeddingInputTokens += c.embeddingInputTokens;
    totals.embeddingInputCost += c.embeddingInputCost;
  }

  return { conversations, totals };
}

/**
 * Aggregate OpenAI usage for a single conversation (chat + embedding by default).
 */
async function getOpenAIUsageForConversation(
  userId,
  conversationId,
  { startDate, endDate } = {}
) {
  const match = {
    type: { $in: CONVERSATION_USAGE_TYPES },
  };
  if (userId) match.userId = toObjectIdOrValue(userId);
  if (conversationId) match.conversationId = toObjectIdOrValue(conversationId);
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const rows = await OpenAIUsage.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cacheTokens: { $sum: '$cacheTokens' },
        totalTokens: { $sum: '$totalTokens' },
        inputCost: { $sum: '$inputCost' },
        outputCost: { $sum: '$outputCost' },
        cacheCost: { $sum: '$cacheCost' },
        totalCost: { $sum: '$totalCost' },
        totalRequests: { $sum: 1 },
      },
    },
  ]);

  const result = {
    ...emptyUsageTotals(),
    embeddingInputTokens: 0,
    embeddingInputCost: 0,
  };

  for (const row of rows) {
    if (row._id === 'embedding') {
      result.embeddingInputTokens += row.inputTokens || 0;
      result.embeddingInputCost += row.inputCost || 0;
    } else if (isChatUsageType(row._id)) {
      result.inputTokens += row.inputTokens || 0;
      result.outputTokens += row.outputTokens || 0;
      result.cacheTokens += row.cacheTokens || 0;
      result.totalTokens += row.totalTokens || 0;
      result.inputCost += row.inputCost || 0;
      result.outputCost += row.outputCost || 0;
      result.cacheCost += row.cacheCost || 0;
      result.totalCost += row.totalCost || 0;
      result.totalRequests += row.totalRequests || 0;
    }
  }

  return result;
}

module.exports = {
  logOpenAIUsage,
  logUsageForCategory,
  computeTokenCosts,
  getOpenAIUsage,
  getOpenAIUsageByType,
  getOpenAIUsageGroupedByAgent,
  getOpenAIUsageGroupedByConversation,
  getOpenAIUsageForConversation,
  emptyUsageTotals,
  CHAT_USAGE_TYPES,
  CONVERSATION_USAGE_TYPES,
  logQdrantUsage,
  getQdrantUsage
};
