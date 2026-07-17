const { AiModelsCategory, AiModel } = require("../models/AiModel");

// in memory cache for ai model data
let cache = {};
const CACHE_TTL = 30000; // 30 seconds

const CATEGORY_ENV_FALLBACKS = {
  intent: {
    provider: "openai",
    model: process.env.OPENAI_ROUTER_MODEL || "gpt-4.1-nano",
  },
  chat: {
    provider: "openai",
    model:
      process.env.OPENAI_CHAT_MODEL_PREMIUM ||
      process.env.OPENAI_CHAT_MODEL ||
      "gpt-4.1",
  },
  "brief-chat": {
    provider: "openai",
    model: process.env.OPENAI_CHAT_MODEL_BRIEF || "gpt-4.1-mini",
  },

  embedding: {
    provider: "openai",
    model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingDimension: Number(process.env.OPENAI_EMBEDDING_DIMENSION) || 1536,
  },
  "micro-classifier": {
    provider: process.env.LLAMA_MICRO_PROVIDER || "groq",
    model: process.env.LLAMA_MICRO_MODEL || "llama-3.1-8b-instant",
    timeoutMs: Number(process.env.LLAMA_MICRO_TIMEOUT_MS) || 2000,
  },
  "website-classifier": {
    provider: process.env.LLAMA_WEBSITE_TYPE_PROVIDER || "groq",
    model: process.env.LLAMA_WEBSITE_TYPE_MODEL || "llama-3.1-8b-instant",
    timeoutMs: Number(process.env.LLAMA_WEBSITE_TYPE_TIMEOUT_MS) || 30000,
  },
  greeting: {
    provider:
      process.env.LLAMA_PROVIDER || process.env.LLAMA_MICRO_PROVIDER || "groq",
    model:
      process.env.LLAMA_MODEL ||
      process.env.LLAMA_MICRO_MODEL ||
      "llama-3.1-8b-instant",
    timeoutMs:
      Number(process.env.LLAMA_TIMEOUT_MS || process.env.LLAMA_MICRO_TIMEOUT_MS) ||
      4000,
  },
  "open-source": {
    provider: process.env.LLAMA_MICRO_PROVIDER || "groq",
    model: process.env.LLAMA_MICRO_MODEL || "llama-3.1-8b-instant",
    timeoutMs: Number(process.env.LLAMA_MICRO_TIMEOUT_MS) || 2000,
  },
};

exports.clearModelCache = () => {
  cache = {};
};

/**
 * Fetch active AI model configuration for a specific category.
 * Cached to prevent hitting the database multiple times during parallel/consecutive steps of a request.
 *
 * @param {string} category - e.g. 'chat', 'embedding', 'intent', 'micro-classifier'
 * @returns {Promise<Object>} The active model record object
 */
exports.getModelForCategory = async (category) => {
  const now = Date.now();
  const cached = cache[category];

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.promise;
  }

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
        `No active AI model configured for category "${category}"`,
      );
    }

    return aiModel;
  })();

  cache[category] = {
    promise: fetchPromise,
    timestamp: now,
  };

  fetchPromise.catch(() => {
    if (cache[category] && cache[category].promise === fetchPromise) {
      delete cache[category];
    }
  });

  return fetchPromise;
};

/**
 * Resolve a usable runtime config for a category.
 * DB active model wins for model name / provider / costs / timeout;
 * env wins for API keys (GROQ_API_KEY, OPENAI_API_KEY).
 * Falls back to env defaults when no active DB model exists.
 *
 * @param {string} category
 * @param {string[]} [fallbackCategories] - try these if primary category has no active model
 */
exports.getResolvedModelConfig = async (
  category,
  fallbackCategories = [],
) => {
  const categoriesToTry = [category, ...fallbackCategories];
  let record = null;
  let resolvedCategory = category;

  console.log("categories to try : ",categoriesToTry);

  for (const cat of categoriesToTry) {
    try {
      record = await exports.getModelForCategory(cat);
      resolvedCategory = cat;
      break;
    } catch {
      record = null;
    }
  }

  const fallback = CATEGORY_ENV_FALLBACKS[resolvedCategory] ||
    CATEGORY_ENV_FALLBACKS[category] || {
      provider: "openai",
      model: "gpt-4.1-mini",
    };

  const provider = String(
    record?.provider || fallback.provider || "openai",
  ).toLowerCase();

  const cfg = record?.providerConfig || {};
  const timeoutMs =
    Number(cfg.timeoutMs) ||
    Number(fallback.timeoutMs) ||
    30000;

  // Env wins for API keys so local vs production stay correct.
  const baseUrl = String(cfg.baseUrl || "").trim();

  let apiKey = "";
  if (provider === "groq") {
    apiKey = process.env.GROQ_API_KEY || cfg.apiKey || "";
  } else if (provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY || cfg.apiKey || "";
  } else {
    apiKey = cfg.apiKey || "";
  }

  const embeddingDimension =
    record?.embeddingDimension ||
    fallback.embeddingDimension ||
    Number(process.env.OPENAI_EMBEDDING_DIMENSION) ||
    1536;

  return {
    category: resolvedCategory,
    fromDb: Boolean(record),
    status: record?.status || "active",
    model: record?.model || fallback.model,
    provider,
    baseUrl,
    apiKey,
    timeoutMs,
    embeddingDimension,
    inputCost: record?.inputCost ?? 0,
    outputCost: record?.outputCost ?? 0,
    cacheCost: record?.cacheCost ?? 0,
    record,
  };
};

/**
 * Normalize an AiModel category for OpenAIUsage.type storage.
 * Categories are dynamic — only applies known typo aliases.
 */
exports.usageTypeForCategory = (category) => {
  const cat = String(category || "chat").trim().toLowerCase();
  return cat || "chat";
};

exports.CATEGORY_ENV_FALLBACKS = CATEGORY_ENV_FALLBACKS;


