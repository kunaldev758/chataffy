const { AiModelsCategory, AiModel } = require("../models/AiModel");

// in memory cache for ai model data 
let cache = {};
const CACHE_TTL = 30000; // 30 seconds

// when admin add/update/delete model then we have to clear cache
exports.clearModelCache = () => {
  cache = {};
};

/**
 * Fetch active AI model configuration for a specific category.
 * Cached to prevent hitting the database multiple times during parallel/consecutive steps of a request.
 *
 * @param {string} category - The category to fetch the active model for (e.g. 'chat', 'embedding', 'intent')
 * @returns {Promise<Object>} The active model record object
 */
exports.getModelForCategory = async (category) => {
  const now = Date.now();
  const cached = cache[category];

  // Return the cached promise if it exists and is within TTL
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return cached.promise;
  }

  // Define the DB lookup promise
  const fetchPromise = (async () => {
    const model = await AiModelsCategory.findOne({
      category: category,
    })
      .select("_id")
      .lean();

    if (!model) {
      throw new Error(`No AI model category found for "${category}"`);
    }

    const aiModel = await AiModel.findOne({
      status: "active",
      categories: model._id,
    }).lean();

    if (!aiModel) {
      throw new Error(
        `No active AI model configured for category "${category}"`
      );
    }

    return aiModel;
  })();

  // Cache the promise immediately so concurrent requests share the exact same promise/query
  cache[category] = {
    promise: fetchPromise,
    timestamp: now,
  };

  // If the lookup fails, clean up the cache so subsequent requests can try again
  fetchPromise.catch(() => {
    if (cache[category] && cache[category].promise === fetchPromise) {
      delete cache[category];
    }
  });

  return fetchPromise;
};
