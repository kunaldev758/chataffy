const mongoose = require("mongoose");
const clientSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
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

    plan: {
      type: String,
      default: "free",
      lowercase: true,
    },
    planStatus: {
      type: String,
      default: "active", // e.g., 'active', 'inactive', 'cancelled'
      lowercase: true,
    },
    paymentStatus: {
      type: String,
      default: "unpaid", // e.g., 'paid', 'unpaid', 'pending'
      lowercase: true,
    },
    planExpiry: {
      type: Date,
      default: null,
    },
    planPurchaseDate: {
      type: Date,
      default: null,
    },
    billingCycle: {
      type: String,
      default: "monthly", //e.g., 'monthly', 'yearly'
    },
    totalAmountPaid: {
      type: Number,
      default: 0,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);
const Client = mongoose.model("Client", clientSchema);
module.exports = Client;
