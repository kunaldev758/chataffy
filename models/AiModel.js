const mongoose = require("mongoose");

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

    categories: { type: [String], required: true, index: true, default: [] }, // e.g. "chat", "completion", "embedding", "search", "vector" "open-source"
  },
  { timestamps: true },
);

aiModelSchema.pre("save", function(next) {
  if(this.isModified("inputCost") || this.isModified("outputCost") || this.isModified("cacheCost")) {
    this.totalCost = this.inputCost + this.outputCost + this.cacheCost;
  }
  next();
});

const AiModel = mongoose.model("AiModel", aiModelSchema);

module.exports = AiModel;
