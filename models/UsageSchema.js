// const mongoose = require('mongoose');

// // Add Usage Schema for cost tracking
// const UsageSchema = new mongoose.Schema({
//   userId: { type: String, required: true },
//   timestamp: { type: Date, default: Date.now },
//   operation: { type: String, required: true }, // 'embedding', 'pinecone_query', 'chat_completion'
//   details: {
//     inputTokens: Number,
//     outputTokens: Number,
//     vectorCount: Number,
//     cost: Number,
//   },
// });

// const Usage = mongoose.model("Usage", UsageSchema);
// module.exports = Usage;

// models/UsageSchema.js

const mongoose = require('mongoose');

const UsageSchema = new mongoose.Schema({
  userId: {
    type: String, // Or mongoose.Schema.Types.ObjectId if linking to a User/Client collection
    required: true,
    index: true // Indexing userId is good for querying user-specific usage
  },
  timestamp: { // Keep top-level timestamp for sorting/querying ranges easily
    type: Date,
    default: Date.now,
    index: true // Indexing timestamp is good for date range queries
  },
  operation: { // e.g., 'train-data', 'chat', 'pinecone-query', 'api-call'
    type: String,
    required: true,
    index: true // Indexing operation type can be useful for reports
  },
  details: {
    // --- Standardized Cost and Credit Information ---
    cost: { // Total cost of this operation in dollars
      type: Number,
      required: true,
      default: 0
    },
    creditsCharged: { // Credits deducted for this operation
        type: Number,
        required: true,
        default: 0
    },
    costBreakdown: { // Detailed breakdown from the pricing service
        embeddingCost: { type: Number, default: 0 },
        completionCost: { type: Number, default: 0 },
        pineconeCost: { type: Number, default: 0 },
        // Add other potential cost components if your pricing service calculates them
        // e.g., imageCost: { type: Number, default: 0 },
        type: Map, // Use a Map for flexibility if breakdown structure might change
        of: Number, // Values in the map should be numbers
        default: {}
    },

    // --- Optional Operation-Specific Details ---
    // These fields capture inputs/metadata relevant to the specific operation
    // Only include fields that you consistently want to query or display.
    // Other arbitrary details can still be saved without being explicitly defined here
    // if the schema allows for flexible fields (which Mongoose does by default).

    embeddingModel: String,   // e.g., 'text-embedding-3-small'
    completionModel: String,  // e.g., 'gpt-3.5-turbo'
    promptTokens: Number,     // Input tokens for LLM
    completionTokens: Number, // Output tokens from LLM
    embeddingTokens: Number,  // Tokens used for embedding
    pineconeQueries: Number,  // Number of Pinecone queries
    conversationId: String,   // Identifier for chat sessions
    trainingListId: String,   // Identifier for training data items
    jobId: String,            // Identifier for background jobs (BullMQ)

    // You can add more specific fields as needed for different operations

    // Consider adding the timestamp within details if needed for specific reporting,
    // but the top-level timestamp is usually sufficient.
    // loggedAt: { type: Date, default: Date.now },
  },
});

// --- Compound Indexes (Optional but Recommended) ---
// For fetching user usage within a date range, sorted by time
UsageSchema.index({ userId: 1, timestamp: -1 });
// For fetching specific operations for a user, sorted by time
UsageSchema.index({ userId: 1, operation: 1, timestamp: -1 });
// If you frequently query by conversationId
// UsageSchema.index({ conversationId: 1, timestamp: -1 });


const Usage = mongoose.model("Usage", UsageSchema);

module.exports = Usage;