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
  shopify: "SF_TOKEN",
  bigcommerce: "BC_TOKEN",
  web: "TOKEN",
};

const ROLE_COOKIE = "role";
const LEGACY_TOKEN_COOKIE = "token";

const DEFAULT_COOKIE_PATH = "/";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_PREFIXES = Object.values(TOKEN_KEYS);

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

/**
 * Generate final cookie name
 *
 * Examples:
 * SF_TOKEN_store123
 * BC_TOKEN_client456
 * TOKEN_web
 */
function getTokenCookieName({
  platform = "web",
  clientId = "default",
  sessionId,
} = {}) {
  const baseKey = getBaseTokenKey(platform);
  const safeClientId = sanitizeClientId(clientId);
  if (sessionId) {
    return `${baseKey}_${safeClientId}_${sanitizeClientId(sessionId)}`;
  }
  return `${baseKey}_${safeClientId}`;
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
 * Collect candidate JWTs (Authorization + all auth cookies).
 * Supports multiple concurrent sessions on the same platform.
 */
function extractAuthTokens(req) {
  const tokens = [];
  const rawAuth = req?.header?.("Authorization") ?? req?.headers?.authorization;
  const bearer = rawAuth?.replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    tokens.push(bearer);
  }

  const cookies = req?.cookies || {};
  if (cookies[LEGACY_TOKEN_COOKIE]) {
    tokens.push(cookies[LEGACY_TOKEN_COOKIE]);
  }

  for (const [name, value] of Object.entries(cookies)) {
    if (value && isAuthTokenCookieName(name)) {
      tokens.push(value);
    }
  }

  return [...new Set(tokens)];
}

/** First candidate token (backward compatible). */
function extractAuthToken(req) {
  const tokens = extractAuthTokens(req);
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
  const cookieName = getTokenCookieName({
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    sessionId,
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

  if (sessionId) {
    res.clearCookie(
      getTokenCookieName({
        platform: resolvedPlatform,
        clientId: resolvedClientId,
        sessionId,
      }),
      clearOptions,
    );
  }

  res.clearCookie(
    getTokenCookieName({ platform: resolvedPlatform, clientId: resolvedClientId }),
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
  getTokenCookieName,
  sanitizeClientId,
  isAuthTokenCookieName,
  resolvePlatform,
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
