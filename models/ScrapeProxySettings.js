const mongoose = require("mongoose");

const scrapeProxySettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "default",
    },
    proxies: {
      type: String,
      default: "",
    },
    requestsPerProxy: {
      type: Number,
      default: 100,
      min: 1,
    },
    maxRetries: {
      type: Number,
      default: 1,
      min: 0,
    },
    requestDelayMs: {
      type: Number,
      default: 100,
      min: 0,
    },
    discoveryDelayMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    proxyTrainingOnly: {
      type: Boolean,
      default: true,
    },
    proxyFallbackDirect: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

const ScrapeProxySettings = mongoose.model(
  "ScrapeProxySettings",
  scrapeProxySettingsSchema,
);

module.exports = ScrapeProxySettings;
