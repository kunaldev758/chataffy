const mongoose = require("mongoose");
const openAIUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: Date, default: Date.now },
  tokens: { type: Number, default: 0 },
  requests: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  model: { type: String },
});

const OpenAIUsage = mongoose.model("OpenAIUsage", openAIUsageSchema);

module.exports = OpenAIUsage;
