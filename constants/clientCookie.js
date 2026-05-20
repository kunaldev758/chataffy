/**
 * Multi-platform / multi-client auth cookie management
 * Supports:
 * - Shopify
 * - BigCommerce
 * - Web
 * - Multiple clients/stores
 */

const { getAuthCookieOptions } = require("../helpers/helper.js");

const TOKEN_KEYS = {
  shopify: "SP_TOKEN",
  bigcommerce: "BC_TOKEN",
  web: "WEB_TOKEN",
};

/** Cookie base names from older builds — still read and cleared for migration */
const LEGACY_COOKIE_BASE_KEYS = ["SF_TOKEN", "TOKEN"];

const ROLE_COOKIE = "role";
const LEGACY_TOKEN_COOKIE = "WEB_TOKEN";

const DEFAULT_COOKIE_PATH = "/";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_PREFIXES = [
  ...new Set([...Object.values(TOKEN_KEYS), ...LEGACY_COOKIE_BASE_KEYS]),
];

function sanitizeClientId(clientId) {
  const safe = String(clientId ?? "default")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
  return safe || "default";
}

function normalizeCookiePath(raw) {
  const trimmed =
    (raw && String(raw).trim()) || DEFAULT_COOKIE_PATH;

  let p = trimmed.startsWith("/")
    ? trimmed
    : `/${trimmed}`;

  while (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }

  return p || DEFAULT_COOKIE_PATH;
}

function getBaseTokenKey(platform = "web") {
  return TOKEN_KEYS[platform] || TOKEN_KEYS.web;
}

function sanitizeShopDomain(shopDomain) {
  const raw = String(shopDomain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  return sanitizeClientId(raw.replace(/\.myshopify\.com$/i, "myshopifycom"));
}

/**
 * Stable cookie names per platform/store.
 *
 * Web: WEB_TOKEN
 * Shopify: SP_TOKEN_<sanitizedShopDomain>
 * BigCommerce: BC_TOKEN_<storeHash>
 */
function getPlatformCookieName({ platform = "web", shopDomain, storeHash, clientId } = {}) {
  const baseKey = getBaseTokenKey(platform);

  if (platform === "web") {
    return baseKey;
  }

  if (platform === "shopify") {
    const safeShop = sanitizeShopDomain(shopDomain ?? clientId);
    return `${baseKey}_${safeShop}`;
  }

  if (platform === "bigcommerce") {
    const safeStore = sanitizeClientId(storeHash ?? clientId);
    return `${baseKey}_${safeStore}`;
  }

  const safeClientId = sanitizeClientId(clientId);
  return `${baseKey}_${safeClientId}`;
}

/**
 * Generate final cookie name
 *
 * Examples:
 * SP_TOKEN_mystoremyshopifycom
 * BC_TOKEN_abcd123
 * WEB_TOKEN
 */
function getTokenCookieName({
  platform = "web",
  clientId = "default",
  sessionId, // ignored for cookie names (kept for backward compat callers)
} = {}) {
  return getPlatformCookieName({ platform, clientId });
}

function isAuthTokenCookieName(name) {
  if (!name) return false;
  return TOKEN_PREFIXES.some(
    (prefix) => name === prefix || name.startsWith(`${prefix}_`),
  );
}

function resolvePlatform(req) {
  const explicit =
    req?.headers?.["x-chataffy-platform"] ||
    req?.body?.platform ||
    req?.query?.platform;

  if (explicit && TOKEN_KEYS[explicit]) {
    return explicit;
  }

  const path = String(req?.originalUrl || req?.path || req?.url || "");
  if (/\/shopify\b/i.test(path)) return "shopify";
  if (/\/bigcommerce\b/i.test(path)) return "bigcommerce";

  const provider = req?.body?.provider || req?.query?.provider;
  if (provider === "shopify" || provider === "bigcommerce") {
    return provider;
  }

  return "web";
}

/**
 * When non-null, UserSession.platform must match (strict multi-platform routing).
 * Returns null when the request does not declare a platform (legacy clients / generic APIs).
 */
function getRequestSessionPlatform(req) {
  const explicit =
    req?.headers?.["x-chataffy-platform"] ||
    req?.body?.platform ||
    req?.query?.platform;
  if (explicit && TOKEN_KEYS[explicit]) {
    return explicit;
  }
  const path = String(req?.originalUrl || req?.path || req?.url || "");
  if (/\/shopify\b/i.test(path)) return "shopify";
  if (/\/bigcommerce\b/i.test(path)) return "bigcommerce";
  return null;
}

function resolveClientId(req, overrides = {}) {
  if (overrides.clientId != null) {
    return sanitizeClientId(overrides.clientId);
  }

  const platform = overrides.platform || resolvePlatform(req);

  if (platform === "shopify") {
    const shop =
      overrides.storeHash ||
      overrides.shop ||
      req?.query?.shop ||
      req?.body?.shopifyShop ||
      req?.body?.shop;
    if (shop) {
      return sanitizeClientId(
        String(shop)
          .replace(/^https?:\/\//i, "")
          .replace(/\/$/, ""),
      );
    }
  }

  if (platform === "bigcommerce") {
    const storeHash =
      overrides.storeHash ||
      req?.query?.store_hash ||
      req?.body?.bigcommerceStoreHash ||
      req?.body?.bcStoreHash;
    if (storeHash) {
      return sanitizeClientId(storeHash);
    }
  }

  const headerClientId = req?.headers?.["x-chataffy-client-id"];
  const bodyClientId = req?.body?.clientId;
  if (headerClientId || bodyClientId) {
    return sanitizeClientId(headerClientId || bodyClientId);
  }

  return "default";
}

function getCookieOptions(req) {
  const base = req ? getAuthCookieOptions(req) : {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SEVEN_DAYS_MS,
    path: normalizeCookiePath(process.env.COOKIE_PATH),
  };

  return {
    ...base,
    path: normalizeCookiePath(
      base.path || process.env.COOKIE_PATH || DEFAULT_COOKIE_PATH,
    ),
    maxAge: base.maxAge ?? SEVEN_DAYS_MS,
    httpOnly: true,
  };
}

function getClearCookieOptions(req) {
  const { maxAge, ...rest } = getCookieOptions(req);
  return rest;
}

function listAuthTokenCookieNames(req) {
  const names = new Set();
  const cookies = req?.cookies || {};

  for (const name of Object.keys(cookies)) {
    if (isAuthTokenCookieName(name)) {
      names.add(name);
    }
  }

  names.add(LEGACY_TOKEN_COOKIE);
  return [...names];
}

/**
 * Collect candidate JWTs (Authorization + legacy cookie + platform-scoped cookie).
 *
 * IMPORTANT: Never scan random token cookies; platform cookie must be explicit.
 */
function extractAuthTokens(req, { platform, shopDomain, storeHash, clientId } = {}) {
  const tokens = [];
  const rawAuth = req?.header?.("Authorization") ?? req?.headers?.authorization;
  const bearer = rawAuth?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    for (const part of bearer.split(",").map((s) => s.trim()).filter(Boolean)) {
      tokens.push(part);
    }
  }

  const cookies = req?.cookies || {};
  if (cookies[LEGACY_TOKEN_COOKIE]) {
    tokens.push(cookies[LEGACY_TOKEN_COOKIE]);
  }

  const resolvedPlatform = platform || resolvePlatform(req);
  const resolvedClientId = clientId || resolveClientId(req, { platform: resolvedPlatform });
  const cookieName = getPlatformCookieName({
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    shopDomain,
    storeHash,
  });
  if (cookieName && cookies[cookieName]) {
    tokens.push(cookies[cookieName]);
  }

  return [...new Set(tokens)];
}

/** First candidate token (backward compatible). */
function extractAuthToken(req, opts = {}) {
  const tokens = extractAuthTokens(req, opts);
  return tokens[0] || null;
}

function setAuthTokenCookie(
  res,
  req,
  { token, platform = "web", clientId, sessionId, role } = {},
) {
  const resolvedPlatform = platform || resolvePlatform(req);
  const resolvedClientId = resolveClientId(req, {
    platform: resolvedPlatform,
    clientId,
  });
  const options = getCookieOptions(req);
  const cookieName = getPlatformCookieName({
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    shopDomain: resolvedPlatform === "shopify" ? resolvedClientId : undefined,
    storeHash: resolvedPlatform === "bigcommerce" ? resolvedClientId : undefined,
  });

  res.cookie(cookieName, token, options);

  if (role) {
    res.cookie(ROLE_COOKIE, role, options);
  }

  return cookieName;
}

/** Clear only the current session cookie (other sessions stay logged in). */
function clearSessionAuthCookie(
  res,
  req,
  { platform, clientId, sessionId } = {},
) {
  const clearOptions = getClearCookieOptions(req);
  const resolvedPlatform = platform || resolvePlatform(req);
  const resolvedClientId = resolveClientId(req, { platform: resolvedPlatform, clientId });

  res.clearCookie(
    getPlatformCookieName({
      platform: resolvedPlatform,
      clientId: resolvedClientId,
      shopDomain: resolvedPlatform === "shopify" ? resolvedClientId : undefined,
      storeHash: resolvedPlatform === "bigcommerce" ? resolvedClientId : undefined,
    }),
    clearOptions,
  );
  res.clearCookie(LEGACY_TOKEN_COOKIE, clearOptions);
}

function clearAuthTokenCookie(res, req, opts = {}) {
  if (opts.sessionId) {
    return clearSessionAuthCookie(res, req, opts);
  }

  const clearOptions = getClearCookieOptions(req);
  for (const name of listAuthTokenCookieNames(req)) {
    res.clearCookie(name, clearOptions);
  }
}

module.exports = {
  TOKEN_KEYS,
  ROLE_COOKIE,
  LEGACY_TOKEN_COOKIE,
  getBaseTokenKey,
  sanitizeShopDomain,
  getPlatformCookieName,
  getTokenCookieName,
  sanitizeClientId,
  isAuthTokenCookieName,
  resolvePlatform,
  getRequestSessionPlatform,
  resolveClientId,
  getCookieOptions,
  getClearCookieOptions,
  extractAuthToken,
  extractAuthTokens,
  setAuthTokenCookie,
  clearSessionAuthCookie,
  clearAuthTokenCookie,
  listAuthTokenCookieNames,
};
