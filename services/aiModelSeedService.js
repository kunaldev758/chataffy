const { AiModel, AiModelsCategory } = require("../models/AiModel");
const { clearModelCache } = require("./aiModelService");

/**
 * Default categories + models for empty / partial installs.
 * Costs are $/1M tokens. Only missing rows are created — never overwrites admin edits.
 */
const DEFAULT_CATEGORIES = [
  "intent",
  "embedding",
  "chat",
  "brief-chat", // legacy typo alias used by existing query paths
  "micro-classifier",
  "content-classifier",
  "website-classifier",
];

/**
 * @type {Array<{
 *   model: string,
 *   provider: 'openai' | 'groq',
 *   status: 'active' | 'inactive',
 *   categories: string[],
 *   inputCost: number,
 *   outputCost: number,
 *   cacheCost: number,
 *   embeddingDimension?: number | null,
 *   timeoutMs?: number,
 * }>}
 */
const DEFAULT_MODELS = [
  {
    model: "gpt-4.1-nano",
    provider: "openai",
    status: "active",
    categories: ["intent", "content-classifier", "website-classifier"],
    inputCost: 0.1,
    outputCost: 0.4,
    cacheCost: 0.025,
    timeoutMs: 30000,
  },
  {
    model: "text-embedding-3-small",
    provider: "openai",
    status: "active",
    categories: ["embedding"],
    inputCost: 0.02,
    outputCost: 0,
    cacheCost: 0,
    embeddingDimension: 1536,
    timeoutMs: 30000,
  },
  {
    model: "gpt-4.1-mini",
    provider: "openai",
    status: "active",
    categories: ["chat"],
    inputCost: 0.4,
    outputCost: 1.6,
    cacheCost: 0.1,
    timeoutMs: 30000,
  },
  {
    model: "gpt-4.1",
    provider: "openai",
    status: "active",
    // brief-chat is canonical; brief-chat kept for legacy lookups
    categories: ["brief-chat"],
    inputCost: 2.0,
    outputCost: 8.0,
    cacheCost: 0.5,
    timeoutMs: 30000,
  },
  {
    model: "llama-3.1-8b-instant",
    provider: "groq",
    status: "active",
    categories: ["micro-classifier"],
    inputCost: 0.05,
    outputCost: 0.08,
    cacheCost: 0,
    // website-classifier needs the longer timeout; shared model uses 30s
    timeoutMs: 30000,
  },
];

/**
 * Ensure default AI model categories and models exist.
 * - Creates missing categories
 * - Creates missing models (by unique `model` name) with costs / provider / dimension
 * - Assigns categories only when a category is currently unassigned
 * - Never changes costs/status/provider on existing models
 *
 * @returns {Promise<{ categoriesCreated: number, modelsCreated: number, categoriesAssigned: number }>}
 */
async function ensureDefaultAiModels() {
  const summary = {
    categoriesCreated: 0,
    modelsCreated: 0,
    categoriesAssigned: 0,
  };

  const categoryByName = new Map();

  for (const name of DEFAULT_CATEGORIES) {
    let doc = await AiModelsCategory.findOne({ category: name });
    if (!doc) {
      try {
        doc = await AiModelsCategory.create({ category: name });
        summary.categoriesCreated += 1;
      } catch (err) {
        // Race: another process created it
        if (err.code === 11000) {
          doc = await AiModelsCategory.findOne({ category: name });
        } else {
          throw err;
        }
      }
    }
    if (doc) categoryByName.set(name, doc);
  }

  for (const def of DEFAULT_MODELS) {
    const categoryIds = def.categories
      .map((name) => categoryByName.get(name)?._id)
      .filter(Boolean);

    let modelDoc = await AiModel.findOne({ model: def.model });
    let justCreated = false;

    if (!modelDoc) {
      try {
        modelDoc = await AiModel.create({
          model: def.model,
          provider: def.provider,
          status: def.status,
          inputCost: def.inputCost,
          outputCost: def.outputCost,
          cacheCost: def.cacheCost,
          totalCost: def.inputCost + def.outputCost + def.cacheCost,
          embeddingDimension: def.embeddingDimension ?? null,
          categories: categoryIds,
          providerConfig: {
            apiKey: "",
            baseUrl: "",
            timeoutMs: def.timeoutMs || 30000,
          },
        });
        justCreated = true;
        summary.modelsCreated += 1;

        if (categoryIds.length) {
          await AiModel.updateMany(
            { _id: { $ne: modelDoc._id } },
            { $pull: { categories: { $in: categoryIds } } },
          );
          summary.categoriesAssigned += categoryIds.length;
        }
      } catch (err) {
        if (err.code === 11000) {
          modelDoc = await AiModel.findOne({ model: def.model });
        } else {
          throw err;
        }
      }
    }

    if (!modelDoc || justCreated) continue;

    // Model exists — only attach categories that no model currently owns
    for (const name of def.categories) {
      const cat = categoryByName.get(name);
      if (!cat) continue;

      const owner = await AiModel.findOne({ categories: cat._id })
        .select("_id model")
        .lean();
      if (owner) continue;

      await AiModel.updateOne(
        { _id: modelDoc._id },
        { $addToSet: { categories: cat._id } },
      );
      await AiModel.updateMany(
        { _id: { $ne: modelDoc._id } },
        { $pull: { categories: cat._id } },
      );
      summary.categoriesAssigned += 1;
    }
  }

  if (
    summary.categoriesCreated > 0 ||
    summary.modelsCreated > 0 ||
    summary.categoriesAssigned > 0
  ) {
    clearModelCache();
    console.log(
      `[aiModelSeed] categories+${summary.categoriesCreated}, models+${summary.modelsCreated}, assigned+${summary.categoriesAssigned}`,
    );
  }

  return summary;
}

module.exports = {
  ensureDefaultAiModels,
  DEFAULT_CATEGORIES,
  DEFAULT_MODELS,
};
