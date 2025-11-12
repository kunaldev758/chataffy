const OpenAIUsage = require('../models/OpenAIUsageSchema');
const QdrantUsage = require('../models/qdrantUsageSchema');


async function logOpenAIUsage({ userId, tokens, requests, cost=0, model = 'gpt-4.1' }) {
  if (!userId) throw new Error('Missing userId for OpenAI usage log.');
  return OpenAIUsage.create({
    userId,
    tokens,
    requests,
    cost,
    model,
    date: new Date()
  });
}

async function getOpenAIUsage(userId, { startDate, endDate } = {}) {
  const query = {};
  if (userId) query.userId = userId;
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  const result = await OpenAIUsage.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalTokens: { $sum: '$tokens' },
        totalRequests: { $sum: '$requests' },
        totalCost: { $sum: '$cost' }
      }
    }
  ]);

  return result[0] || { totalTokens: 0, totalRequests: 0, totalCost: 0 };
}


async function logQdrantUsage({userId, vectorsAdded, vectorsDeleted,storageMB ,collectionName ,estimatedCost}) {
  if (!collectionName) throw new Error('Missing collectionName for Qdrant usage log.');
  return QdrantUsage.create({
    userId,
    vectorsAdded,
    vectorsDeleted,
    storageMB,
    collectionName,
    estimatedCost,
    date: new Date()
  });
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
