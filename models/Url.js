const mongoose = require("mongoose");

/**
 * Pipeline status (Phase 0+). trainStatus kept for existing UI (0/1/2).
 * discovered → queued → fetched → processed | failed | skipped
 */
const URL_PIPELINE_STATUSES = [
  "discovered",
  "queued",
  "fetched",
  "processed",
  "failed",
  "skipped",
];

const urlSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: "Agent",
    },
    /** Legacy: 0-untrained, 1-trained, 2-error */
    trainStatus: {
      type: Number,
      enum: [0, 1, 2],
      default: 0,
    },
    error: {
      type: String,
      default: null,
    },

    // --- Phase 0 pipeline fields ---
    status: {
      type: String,
      enum: URL_PIPELINE_STATUSES,
      default: "discovered",
      index: true,
    },
    contentHash: {
      type: String,
      default: null,
    },
    lastCrawledAt: {
      type: Date,
      default: null,
    },
    lastCheckedAt: {
      type: Date,
      default: null,
    },
    pageType: {
      type: String,
      default: null,
    },
    canonicalUrl: {
      type: String,
      default: null,
    },
    language: {
      type: String,
      default: null,
    },
    failureReason: {
      type: String,
      default: null,
    },
    /** Phase 2: last computed quality score (0–1), null if never scored */
    qualityScore: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true },
);

const Url = mongoose.model("Url", urlSchema);

module.exports = Url;
module.exports.URL_PIPELINE_STATUSES = URL_PIPELINE_STATUSES;
