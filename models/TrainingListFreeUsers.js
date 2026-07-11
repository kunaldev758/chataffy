// models/TrainingListFreeUsers.js
const mongoose = require("mongoose");

const trainingListFreeUsersSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: Number,
    required: true,
    // 0: WebPage, 1: File, 2: Snippet, 3: FAQ
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    ref: "Agent",
  },
  
  // WebPage specific fields
  webPage: {
    url: String,
    sourceCode: String,
  },

  // File specific fields
  fileContent: String,
  fileName: String,
  originalFileName: String,

  // Snippet and FAQ fields
  title: String,
  content: String,

  // Classification and metadata fields
  entity_type: {
    type: String,
    default: "general",
  },
  entity_name: {
    type: String,
    default: null,
  },
  classification_confidence: {
    type: Number,
    default: null,
  },
  classification_reason: {
    type: String,
    default: null,
  },
  content_hash: {
    type: String,
    default: null,
  },
  attributes: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  search_terms: {
    type: [String],
    default: [],
  },
  language: {
    type: String,
    default: null,
  },
  is_active: {
    type: Boolean,
    default: true,
  },

  // Common fields
  trainingStatus: {
    type: Number,
    default: 1,
    // 0:Processing 1: Trained, 2: Failed, 10: Plan Upgrade Required
  },

  error: {
    type: String,
    default: null
  },
  
  dataSize: {
    type: Number,
    default: 0 // Size in bytes
  },
  chunkCount: {
    type: Number,
    default: 0
  },


  lastEdit: {
    type: Date,
    default: Date.now,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  }
});

// Indexes for better performance
trainingListFreeUsersSchema.index({ userId: 1, trainingStatus: 1 });
trainingListFreeUsersSchema.index({ userId: 1, type: 1 });
trainingListFreeUsersSchema.index({ createdAt: 1 });

module.exports = mongoose.model("TrainingListFreeUsers", trainingListFreeUsersSchema);