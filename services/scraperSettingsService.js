const ScrapeProxySettings = require("../models/ScrapeProxySettings");
const {
  applyRuntimeSettings,
} = require("../config/scraper");

const SETTINGS_KEY = "default";

function toPublicSettings(doc) {
  if (!doc) return null;
  return {
    proxies: doc.proxies || "",
    requestsPerProxy: doc.requestsPerProxy,
    maxRetries: doc.maxRetries,
    requestDelayMs: doc.requestDelayMs,
    discoveryDelayMs: doc.discoveryDelayMs,
    proxyTrainingOnly: doc.proxyTrainingOnly,
    proxyFallbackDirect: doc.proxyFallbackDirect,
    updatedAt: doc.updatedAt,
  };
}

async function getOrCreateSettings() {
  let doc = await ScrapeProxySettings.findOne({ key: SETTINGS_KEY });
  if (!doc) {
    doc = await ScrapeProxySettings.create({ key: SETTINGS_KEY });
  }
  return doc;
}

async function loadScrapeProxySettingsIntoRuntime() {
  const doc = await getOrCreateSettings();
  applyRuntimeSettings(doc);
  try {
    const webScraper = require("./WebScraper");
    if (typeof webScraper.reloadConfig === "function") {
      webScraper.reloadConfig();
    }
  } catch {
    /* WebScraper may not be loaded yet during early boot */
  }
  return doc;
}

async function updateScrapeProxySettings(payload) {
  const updates = {};

  if (payload.proxies !== undefined) {
    updates.proxies = String(payload.proxies || "").trim();
  }
  if (payload.requestsPerProxy !== undefined) {
    updates.requestsPerProxy = Number(payload.requestsPerProxy);
  }
  if (payload.maxRetries !== undefined) {
    updates.maxRetries = Number(payload.maxRetries);
  }
  if (payload.requestDelayMs !== undefined) {
    updates.requestDelayMs = Number(payload.requestDelayMs);
  }
  if (payload.discoveryDelayMs !== undefined) {
    updates.discoveryDelayMs = Number(payload.discoveryDelayMs);
  }
  if (payload.proxyTrainingOnly !== undefined) {
    updates.proxyTrainingOnly = Boolean(payload.proxyTrainingOnly);
  }
  if (payload.proxyFallbackDirect !== undefined) {
    updates.proxyFallbackDirect = Boolean(payload.proxyFallbackDirect);
  }

  const doc = await ScrapeProxySettings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: updates },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  applyRuntimeSettings(doc);

  const webScraper = require("./WebScraper");
  if (typeof webScraper.reloadConfig === "function") {
    webScraper.reloadConfig();
  }

  return doc;
}

function validateProxySettingsPayload(body) {
  if (body.proxies !== undefined && typeof body.proxies !== "string") {
    return { success: false, message: "proxies must be a string" };
  }

  const numericFields = [
    "requestsPerProxy",
    "maxRetries",
    "requestDelayMs",
    "discoveryDelayMs",
  ];

  for (const field of numericFields) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value) || value < 0) {
      return { success: false, message: `${field} must be a non-negative number` };
    }
    if (field === "requestsPerProxy" && value < 1) {
      return { success: false, message: "requestsPerProxy must be at least 1" };
    }
  }

  if (
    body.proxyTrainingOnly !== undefined &&
    typeof body.proxyTrainingOnly !== "boolean"
  ) {
    return { success: false, message: "proxyTrainingOnly must be a boolean" };
  }

  if (
    body.proxyFallbackDirect !== undefined &&
    typeof body.proxyFallbackDirect !== "boolean"
  ) {
    return { success: false, message: "proxyFallbackDirect must be a boolean" };
  }

  return { success: true };
}

module.exports = {
  getOrCreateSettings,
  loadScrapeProxySettingsIntoRuntime,
  updateScrapeProxySettings,
  toPublicSettings,
  validateProxySettingsPayload,
};
