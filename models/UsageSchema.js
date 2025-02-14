const mongoose = require('mongoose');

// Add Usage Schema for cost tracking
const UsageSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  operation: { type: String, required: true }, // 'embedding', 'pinecone_query', 'chat_completion'
  details: {
    inputTokens: Number,
    outputTokens: Number,
    vectorCount: Number,
    cost: Number,
  },
});

const Usage = mongoose.model("Usage", UsageSchema);
module.exports = Usage;
