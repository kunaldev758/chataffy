const mongoose = require("mongoose");

const agentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  website_name: {
    type: String,
    required: true,
    trim: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastTrained: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },

  dataTrainingStatus: { type: Number, default: 0 }, // 0-NoCurrentScrapping, 1-RunningScrapping

  scrapingStartTime: { type: Date, default: null }, // Timestamp when scraping started

  pagesAdded: {
    success: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },

  isSitemapAdded: { type: Boolean, default: false },

  filesAdded: { type: Number, default: 0 },

  faqsAdded: { type: Number, default: 0 },

  currentDataSize: { type: Number, default: 0 },

  upgradePlanStatus: {
    storageLimitExceeded: { type: Boolean, default: false },
    agentLimitExceeded: { type: Boolean, default: false },
    chatLimitExceeded: { type: Boolean, default: false },
  },

  qdrantIndexName: { type: String, required: true, unique: true },
  qdrantIndexNamePaid: { type: String, required: true, unique: true },

  liveAgentSupport: {
    type: Boolean,
    default: false,
  },

  isDeleted: {
    type: Boolean,
    default: false,
  },
});

// Update the updatedAt timestamp before saving
agentSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Agent", agentSchema);
