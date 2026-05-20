/**
 * Prevent reuse of OAuth authorization codes (replay of old callback URLs).
 * In-memory only — use Redis or similar for multi-instance deployments.
 */

const USED_CODES = new Map();
const DEFAULT_TTL_MS = 20 * 60 * 1000;

function prune(ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  for (const [code, t] of USED_CODES) {
    if (now - t > ttlMs) USED_CODES.delete(code);
  }
}

/**
 * @returns {boolean} true if this code has not been consumed yet (caller may proceed)
 */
function consumeOAuthCodeOnce(code) {
  if (!code || typeof code !== "string") {
    return false;
  }
  prune();
  if (USED_CODES.has(code)) {
    return false;
  }
  USED_CODES.set(code, Date.now());
  return true;
}

module.exports = {
  consumeOAuthCodeOnce,
  prune,
};
