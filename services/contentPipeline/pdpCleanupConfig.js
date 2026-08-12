/**
 * PDP RAG cleanup feature flags / thresholds.
 * Cleanup is OFF by default so existing train flows stay unchanged until enabled.
 */

function envFlag(name, defaultOn = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultOn;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isPdpRagCleanupEnabled() {
  return envFlag("PDP_RAG_CLEANUP", false);
}

function getPdpCleanBodyMinChars() {
  return envInt("PDP_CLEAN_BODY_MIN_CHARS", 120);
}

function getPdpMaxMarkdownChars() {
  return envInt("PDP_MAX_MARKDOWN_CHARS", 8000);
}

function getPdpVariantMarkdownLimit() {
  return envInt("PDP_VARIANT_MARKDOWN_LIMIT", 12);
}

module.exports = {
  isPdpRagCleanupEnabled,
  getPdpCleanBodyMinChars,
  getPdpMaxMarkdownChars,
  getPdpVariantMarkdownLimit,
  envFlag,
  envInt,
};
