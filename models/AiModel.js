const mongoose = require("mongoose");

const aiModelsCategoriesSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);


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

    inputCost: { type: Number, required: true, default: 0 }, // per million tokens

    outputCost: { type: Number, required: true, default: 0 }, // per million tokens

    cacheCost: { type: Number, required: true, default: 0 }, // per million tokens

    totalCost: { type: Number, required: true, default: 0 }, // per million tokens

    categories: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AiModelsCategory" }],
      required: true,
      index: true,
      default: [],
    }, // e.g. "chat", "completion", "embedding", "search", "vector" "open-source"
  },
  { timestamps: true },
);

aiModelSchema.pre("save", function(next) {
  if(this.isModified("inputCost") || this.isModified("outputCost") || this.isModified("cacheCost")) {
    this.totalCost = this.inputCost + this.outputCost + this.cacheCost;
  }
  next();
});

async function updateTotalCost(next) {
  const update = this.getUpdate();

  if (!update) return next();

  const $set = update.$set || update;

  const needsUpdate =
    "inputCost" in $set ||
    "outputCost" in $set ||
    "cacheCost" in $set;

  if (!needsUpdate) return next();

  // Get current document
  const doc = await this.model.findOne(this.getQuery());

  if (!doc) return next();

  const inputCost =
    $set.inputCost ?? doc.inputCost;

  const outputCost =
    $set.outputCost ?? doc.outputCost;

  const cacheCost =
    $set.cacheCost ?? doc.cacheCost;

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
const AiModelsCategory = mongoose.model("AiModelsCategory", aiModelsCategoriesSchema);

module.exports = {
  AiModel,
  AiModelsCategory,
};
