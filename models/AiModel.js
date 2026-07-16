const mongoose = require("mongoose");

const aiModelsCategoriesSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

const PROVIDERS = ["openai", "groq"];

const aiModelSchema = new mongoose.Schema(
  {
    model: { type: String, required: true, unique: true },

    status: {
      type: String,
      required: true,
      index: true,
      default: "active",
      enum: ["active", "inactive"],
    },

    provider: {
      type: String,
      required: true,
      default: "openai",
      enum: PROVIDERS,
      index: true,
    },

    /** Embedding vector size (e.g. 1536). Only used for embedding models. */
    embeddingDimension: {
      type: Number,
      default: null,
    },

    inputCost: { type: Number, required: true, default: 0 }, // per million tokens
    outputCost: { type: Number, required: true, default: 0 }, // per million tokens
    cacheCost: { type: Number, required: true, default: 0 }, // per million tokens
    totalCost: { type: Number, required: true, default: 0 }, // per million tokens

    /**
     * Provider-specific connection settings.
     * apiKey is an optional override — env vars win for local vs production:
     *   GROQ_API_KEY, OPENAI_API_KEY
     */
    providerConfig: {
      apiKey: { type: String, default: "" },
      baseUrl: { type: String, default: "" },
      timeoutMs: { type: Number, default: 30000 },
      deploymentName: { type: String, default: "" },
      organization: { type: String, default: "" },
      project: { type: String, default: "" },
      apiVersion: { type: String, default: "" },
    },

    categories: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AiModelsCategory" }],
      required: true,
      index: true,
      default: [],
    },
  },
  { timestamps: true },
);

aiModelSchema.pre("save", function (next) {
  if (
    this.isModified("inputCost") ||
    this.isModified("outputCost") ||
    this.isModified("cacheCost")
  ) {
    this.totalCost = this.inputCost + this.outputCost + this.cacheCost;
  }
  next();
});

async function updateTotalCost(next) {
  const update = this.getUpdate();

  if (!update) return next();

  const $set = update.$set || update;

  const needsUpdate =
    "inputCost" in $set || "outputCost" in $set || "cacheCost" in $set;

  if (!needsUpdate) return next();

  const doc = await this.model.findOne(this.getQuery());

  if (!doc) return next();

  const inputCost = $set.inputCost ?? doc.inputCost;
  const outputCost = $set.outputCost ?? doc.outputCost;
  const cacheCost = $set.cacheCost ?? doc.cacheCost;

  $set.totalCost = inputCost + outputCost + cacheCost;

  if (update.$set) {
    update.$set = $set;
  } else {
    Object.assign(update, $set);
  }

  next();
}

aiModelSchema.pre("findOneAndUpdate", updateTotalCost);
aiModelSchema.pre("updateOne", updateTotalCost);

const AiModel = mongoose.model("AiModel", aiModelSchema);
const AiModelsCategory = mongoose.model(
  "AiModelsCategory",
  aiModelsCategoriesSchema,
);

module.exports = {
  AiModel,
  AiModelsCategory,
  PROVIDERS,
};
