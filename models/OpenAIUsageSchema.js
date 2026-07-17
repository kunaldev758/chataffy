const mongoose = require("mongoose");

const openAIUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      required: false,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: false,
    },

    inputCost: { type: Number, required: true, default: 0 }, // per million tokens
    outputCost: { type: Number, required: true, default: 0 }, // per million tokens
    cacheCost: { type: Number, required: true, default: 0 }, // per million tokens
    totalCost: { type: Number, required: true, default: 0 }, // per million tokens

    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cacheTokens: { type: Number, required: true, default: 0 },
    totalTokens: { type: Number, required: true, default: 0 },

    model: { type: String },
    /** AiModel category name (dynamic — matches AiModelsCategory.category). */
    type: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
  },
  { timestamps: true },
);

const OpenAIUsage = mongoose.model("OpenAIUsage", openAIUsageSchema);

module.exports = OpenAIUsage;
