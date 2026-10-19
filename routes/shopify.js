const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Store = require("../models/Store");
const User = require("../models/User");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const {
  provisionNewMerchantUser,
  provisionAgentForStore,
} = require("../services/CommerceMerchantProvisionService");
const PlanService = require("../services/PlanService");
const { getAuthCookieOptions } = require("../helpers/helper");
const { sendWelcomeEmail } = require("../services/emailService");
const UserSession = require("../models/userSession");

const router = express.Router();

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES =
  process.env.SHOPIFY_SCOPES || "read_products,read_content";
const SHOPIFY_CALLBACK_URL = `${process.env.BASE_URL}api/shopify/auth/callback`;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const APP_UNINSTALLED_WEBHOOK_URL = `${process.env.BASE_URL}api/shopify/webhooks/app-uninstalled`;


const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const TOKEN_EXCHANGE_SUBJECT_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:id_token";
const TOKEN_EXCHANGE_OFFLINE_TOKEN_TYPE =
  "urn:shopify:params:oauth:token-type:offline-access-token";
// Refresh the access token slightly before it actually expires.
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function isShopifyConfigured() {
  return Boolean(SHOPIFY_CLIENT_ID && SHOPIFY_API_SECRET);
}

function normalizeShopDomain(shop) {
  const value = String(shop || "")
    .trim()
    .toLowerCase();
  return value.endsWith(".myshopify.com") ? value : null;
}

function shopAdminAppUrl(shopDomain) {
  return `https://${shopDomain}/admin/apps/${encodeURIComponent(SHOPIFY_CLIENT_ID)}`;
}

/**
 * Verify a Shopify session token (id_token JWT) per the official spec:
 * HS256 signed with the app secret, `aud` = client id, and shop derived
 * from the `dest` claim. Throws on an invalid/expired token.
 * https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
 */
function verifySessionToken(idToken) {
  const payload = jwt.verify(idToken, SHOPIFY_API_SECRET, {
    algorithms: ["HS256"],
    audience: SHOPIFY_CLIENT_ID,
    clockTolerance: 5,
  });
  const shop = normalizeShopDomain(new URL(payload.dest).hostname);
  if (!shop) throw new Error("Invalid dest claim in session token");
  return { payload, shop };
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * OAuth `state` that is cryptographically bound to the shop the install was
 * started for (nonce.timestamp.hmac(nonce|timestamp|shop)). The callback
 * verifies it against the shop Shopify reports, so an install started for
 * store A can never complete as store B (and vice versa).
 */
function signOAuthState(shop) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const ts = Date.now().toString(36);
  const sig = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(`${nonce}|${ts}|${shop}`)
    .digest("hex");
  return `${nonce}.${ts}.${sig}`;
}

function verifyOAuthState(state, shop) {
  const [nonce, ts, sig] = String(state || "").split(".");
  if (!nonce || !ts || !sig) return { ok: false, reason: "malformed" };
  const expected = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(`${nonce}|${ts}|${shop}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "shop_mismatch" };
  }
  const issuedAt = parseInt(ts, 36);
  if (!issuedAt || Date.now() - issuedAt > OAUTH_STATE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shopAdminHandle(shop) {
  return String(shop || "").replace(/\.myshopify\.com$/i, "");
}

function sanitizeShopifyClientId(value) {
  const id = String(value || "").trim();
  return /^[0-9a-f]{32}$/i.test(id) ? id : null;
}

function clientIdFromIdToken(idToken) {
  return sanitizeShopifyClientId(readUnverifiedSessionToken(idToken)?.aud);
}

function resolveIncomingClientId(req, fallbackIdToken) {
  const ids = [
    sanitizeShopifyClientId(req?.query?.client_id),
    clientIdFromIdToken(req?.query?.id_token),
    clientIdFromIdToken(req?.query?.session_token),
    clientIdFromIdToken(fallbackIdToken),
  ].filter(Boolean);
  // Prefer the client_id of the app the merchant actually opened, not ours.
  return ids.find((id) => id !== SHOPIFY_CLIENT_ID) || ids[0] || null;
}

function shopifyAppNotFoundMessage(apiKey) {
  const key = String(apiKey || "").trim();
  return (
    "Oauth error application_cannot_be_found: Could not find Shopify API application with api_key " +
    key
  );
}

function credentialErrorUrl(shop, clientId) {
  const base = String(process.env.BASE_URL || "").replace(/\/?$/, "/");
  const params = new URLSearchParams();
  if (shop) params.set("shop", shop);
  const id = sanitizeShopifyClientId(clientId);
  if (id) params.set("client_id", id);
  return `${base}api/shopify/auth/credential-error?${params.toString()}`;
}

/**
 * Shopify-style not-found page using the client_id of the app the merchant
 * actually opened. Never hits /oauth/authorize — a live client_id there
 * would install that app even when our env credentials do not match.
 */
function sendShopifyApplicationNotFound(res, shop, apiKey) {
  const key =
    sanitizeShopifyClientId(apiKey) ||
    sanitizeShopifyClientId(SHOPIFY_CLIENT_ID) ||
    "";
  const detail = escapeHtml(shopifyAppNotFoundMessage(key));
  const handle = shopAdminHandle(shop);
  const adminHref = handle
    ? `https://admin.shopify.com/store/${encodeURIComponent(handle)}`
    : "https://admin.shopify.com";
  return res
    .status(403)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Oauth error application_cannot_be_found</title>` +
        `<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fff;color:#202223;display:flex;align-items:center;justify-content:center;min-height:100vh}main{max-width:520px;padding:48px 24px;text-align:center}h1{font-size:20px;font-weight:600;margin:16px 0 32px}h2{font-size:14px;font-weight:600;margin:0 0 8px;text-align:left}p,ul{font-size:14px;line-height:1.5;color:#6d7175;text-align:left}ul{padding-left:18px}a{color:#2c6ecb}</style></head>` +
        `<body><main>` +
        `<div style="font-size:40px">⚠️</div>` +
        `<h1>Oops, something went wrong.</h1>` +
        `<h2>What happened?</h2>` +
        `<p>${detail}</p>` +
        `<h2>What can I do?</h2>` +
        `<ul><li>Press the back button on your browser</li>` +
        `<li>Return to your <a href="${escapeHtml(adminHref)}">admin dashboard</a></li></ul>` +
        `</main></body></html>`,
    );
}

/**
 * Leave the app iframe, then show the not-found page with the same client_id
 * the merchant installed from. Do not start OAuth.
 */
async function sendExitToShopifyOauthError(res, shop, idToken, incomingClientId) {
  await uninstallOnCredentialMismatch(shop, idToken);
  const clientId =
    sanitizeShopifyClientId(incomingClientId) || clientIdFromIdToken(idToken);
  const url = credentialErrorUrl(shop, clientId);
  const safeUrl = JSON.stringify(url);
  const apiKey = escapeHtml(clientId || SHOPIFY_CLIENT_ID || "");
  return res
    .status(200)
    .set("Content-Type", "text/html; charset=utf-8")
    .set("Cache-Control", "no-store")
    .send(
      `<!doctype html><html><head><meta charset="utf-8">` +
        (apiKey
          ? `<meta name="shopify-api-key" content="${apiKey}">`
          : "") +
        `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>` +
        `<script>(function(){var u=${safeUrl};function go(){if(window.top===window.self){location.replace(u);return;}try{window.open(u,"_top");}catch(e){}try{window.top.location.replace(u);}catch(e){}}go();setTimeout(go,0);})();</script>` +
        `</head><body></body></html>`,
    );
}

/** Show a readable error instead of silently landing on some other store. */
function sendInstallError(res, status, message) {
  return res
    .status(status)
    .set("Content-Type", "text/html; charset=utf-8")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Chataffy – Installation error</title></head>` +
        `<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9f9f9">` +
        `<div style="max-width:480px;text-align:center;padding:24px">` +
        `<h1 style="color:#dc2626;font-size:22px">Installation failed</h1>` +
        `<p style="color:#374151">${escapeHtml(message)}</p></div></body></html>`,
    );
}

function readUnverifiedSessionToken(idToken) {
  try {
    const payload = jwt.decode(idToken);
    if (!payload || typeof payload !== "object") return null;
    const audRaw = payload.aud;
    const aud = Array.isArray(audRaw) ? audRaw[0] : audRaw;
    let shop = null;
    if (payload.dest) {
      try {
        shop = normalizeShopDomain(new URL(String(payload.dest)).hostname);
      } catch {
        shop = null;
      }
    }
    return { aud: typeof aud === "string" ? aud : null, shop };
  } catch {
    return null;
  }
}

function isCredentialMismatchJwtError(err) {
  return (
    err?.name === "JsonWebTokenError" &&
    /invalid signature|audience invalid|invalid token/i.test(err.message || "")
  );
}

function isInvalidShopifyClientError(err) {
  const body = err?.response?.data;
  const text =
    typeof body === "string" ? body : JSON.stringify(body || err?.message || "");
  return /invalid_client|invalid client_secret|application_cannot_be_found/i.test(
    text,
  );
}

function verifyShopifyQueryHmac(query, secret) {
  if (!secret || !query?.hmac) return false;
  const params = { ...query };
  delete params.hmac;
  delete params.signature;
  // Added by our embedded load after Shopify signed the URL.
  delete params.session_token;
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const generated = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  try {
    const a = Buffer.from(generated, "utf8");
    const b = Buffer.from(String(query.hmac), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyShopifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || rawBody == null) return false;
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody), "utf8");
  const hash = crypto
    .createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("base64");
  try {
    const a = Buffer.from(hash, "utf8");
    const b = Buffer.from(String(hmacHeader).trim(), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Sessions are bound to a single store so a token issued for one Shopify
 * store can never be reused to open another store of the same user.
 */
async function findOrReuseUserSession(user, platform, req, storeHash = null) {
  const existing = await UserSession.findOne({
    userId: user._id,
    platform,
    storeHash,
  }).lean();
  if (
    existing &&
    (!existing.expiresAt || existing.expiresAt.getTime() > Date.now())
  ) {
    return existing.token;
  }

  const token = user.generateAuthToken(platform, { storeHash });
  await UserSession.create({
    userId: user._id,
    platform,
    storeHash,
    token,
    ip:
      req.headers["x-client-ip"] ||
      req.ip ||
      (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
    deviceInfo: req.headers["user-agent"] || "unknown",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

/**
 * Normalize Shopify's access token response (expiring offline token) into the
 * fields stored on the Store record.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 */
function parseTokenResponse(data) {
  const now = Date.now();
  return {
    accessToken: data.access_token,
    scope: data.scope || SHOPIFY_SCOPES,
    refreshToken: data.refresh_token || null,
    accessTokenExpiresAt: data.expires_in
      ? new Date(now + data.expires_in * 1000)
      : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000)
      : null,
  };
}

/**
 * Official token exchange: swap a valid session token (id_token) for an
 * expiring offline access token. Shopify returns 400 if the session token is
 * invalid.
 */
async function exchangeSessionTokenForAccessToken(shopDomain, sessionToken) {
  const { data } = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_API_SECRET,
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      requested_token_type: TOKEN_EXCHANGE_OFFLINE_TOKEN_TYPE,
      subject_token: sessionToken,
      subject_token_type: TOKEN_EXCHANGE_SUBJECT_TOKEN_TYPE,
      expiring: 1,
    },
    { headers: { "Content-Type": "application/json", Accept: "application/json" } },
  );
  return parseTokenResponse(data);
}

async function uninstallShopifyAppWithToken(shopDomain, accessToken) {
  const { data } = await axios.post(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      query:
        "mutation { appUninstall { userErrors { field message code } } }",
    },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );
  const userErrors = data?.data?.appUninstall?.userErrors;
  if (userErrors?.length) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
  if (data?.errors?.length) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }
}

async function clearShopifyStoreInstall(shopDomain) {
  await Store.updateOne(
    { storeHash: shopDomain, platform: "shopify" },
    {
      $set: {
        status: "uninstalled",
        lastUninstalledAt: new Date(),
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    },
  );
}

/**
 * Credential mismatch: never keep/create an install. Only uninstall if this
 * request's session token belongs to OUR app (token exchange succeeds).
 * Never use a previously stored token — that would uninstall a valid
 * Chataffy install just because a different app was opened on the same shop.
 */
async function uninstallOnCredentialMismatch(shopDomain, idToken) {
  if (!shopDomain || !idToken) return;
  let accessToken = null;

  try {
    const tokens = await exchangeSessionTokenForAccessToken(
      shopDomain,
      idToken,
    );
    accessToken = tokens?.accessToken || null;
  } catch {
    // Session was issued by a different app than env credentials.
  }

  if (!accessToken) return;

  try {
    await uninstallShopifyAppWithToken(shopDomain, accessToken);
    await clearShopifyStoreInstall(shopDomain);
    console.warn(
      `[Shopify] Uninstalled app from ${shopDomain} after credential mismatch`,
    );
  } catch (err) {
    console.warn(
      "[Shopify] Uninstall after mismatch failed:",
      err.response?.data || err.message,
    );
  }
}

/**
 * Return a usable Admin API access token for a Shopify store, refreshing it
 * with the stored refresh token when it has expired (or is about to). Shopify
 * rotates the refresh token on every refresh, so both are persisted.
 */
async function getValidShopifyAccessToken(store) {
  const expiresAt = store.accessTokenExpiresAt
    ? new Date(store.accessTokenExpiresAt).getTime()
    : null;
  if (
    store.accessToken &&
    expiresAt &&
    expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_BUFFER_MS
  ) {
    return store.accessToken;
  }
  if (!store.refreshToken) {
    throw new Error("No Shopify refresh token stored; merchant must reopen the app");
  }

  const { data } = await axios.post(
    `https://${store.storeHash}/admin/oauth/access_token`,
    {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: store.refreshToken,
    },
    { headers: { "Content-Type": "application/json", Accept: "application/json" } },
  );
  const tokens = parseTokenResponse(data);
  await Store.updateOne(
    { storeHash: store.storeHash, platform: "shopify" },
    {
      $set: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      },
    },
  );
  return tokens.accessToken;
}

async function fetchShopRecord(shopDomain, accessToken) {
  const { data } = await axios.get(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  return data.shop;
}

async function registerAppUninstalledWebhook(shopDomain, accessToken) {
  try {
    await axios.post(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      {
        webhook: {
          topic: "app/uninstalled",
          address: APP_UNINSTALLED_WEBHOOK_URL,
          format: "json",
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    // Shopify returns 422 when the webhook already exists — safe to ignore.
    console.warn(
      "[Shopify] Webhook registration skipped or failed:",
      err.response?.data || err.message,
    );
  }
}

/**
 * Agents that predate per-store support have no `storeHash`. They are handed
 * to the user's oldest Shopify store (the one they were created for), so
 * every agent ends up belonging to exactly one store. Idempotent.
 */
async function claimLegacyAgentsForOldestStore(userId) {
  const oldest = await Store.findOne({ userId, platform: "shopify" })
    .sort({ createdAt: 1 })
    .select("storeHash")
    .lean();
  if (!oldest) return;
  await Agent.updateMany(
    { userId, storeHash: null },
    { $set: { storeHash: oldest.storeHash } },
  );
}

/**
 * Resolve/create the merchant user and upsert the Store record after an
 * access token is obtained (via token exchange or authorization code grant).
 */
async function upsertInstalledShopifyStore({
  shopDomain,
  accessToken,
  scope,
  refreshToken,
  accessTokenExpiresAt,
  refreshTokenExpiresAt,
}) {
  // Verify the access token really belongs to this shop before trusting it.
  const shopRecord = await fetchShopRecord(shopDomain, accessToken);
  if (normalizeShopDomain(shopRecord?.myshopify_domain) !== shopDomain) {
    throw new Error(
      `Shop verification failed: token does not belong to ${shopDomain}`,
    );
  }
  const emailFallback = `shop-${crypto
    .createHash("sha256")
    .update(shopDomain)
    .digest("hex")
    .slice(0, 40)}@example.com`;
  const email = (
    shopRecord.email ||
    shopRecord.customer_email ||
    emailFallback
  ).toLowerCase();
  const displayName = shopRecord.name || shopDomain;

  const [existingStore, existingUser] = await Promise.all([
    Store.findOne({ storeHash: shopDomain, platform: "shopify" }).lean(),
    User.findOne({ email }).lean(),
  ]);

  let newUser;
  let newClient;
  let resolvedClient = null;

  // A store keeps its original owner on reinstall; otherwise the owner is the
  // user with the shop email (same gmail => same user, multiple stores).
  const ownerUserId = existingStore?.userId || existingUser?._id;

  if (ownerUserId) {
    resolvedClient = await Client.findOne({
      $or: [{ userId: ownerUserId }, { email }],
    }).lean();
  }
  if (!existingStore && !existingUser) {
    const provisioned = await provisionNewMerchantUser({
      email,
      name: displayName,
      provider: "shopify",
      storeHash: shopDomain,
    });
    newUser = provisioned.newUser;
    newClient = provisioned.newClient;
  }

  const resolvedUserId = newUser?._id || ownerUserId;
  if (!resolvedUserId) {
    throw new Error("Could not resolve user for Shopify install");
  }

  // Store.clientId is required: never save a store without one.
  if (!newClient && !resolvedClient) {
    const created = await Client.create({ userId: resolvedUserId, email });
    resolvedClient = created.toObject();
  }
  const resolvedClientId = newClient?._id || resolvedClient?._id;

  const store = await Store.findOneAndUpdate(
    { storeHash: shopDomain },
    {
      // Per-store onboarding: only set when the store is first created, so a
      // reinstall never resets onboarding progress.
      $setOnInsert: { isOnboarded: false },
      $set: {
        platform: "shopify",
        userId: resolvedUserId,
        clientId: resolvedClientId,
        accessToken,
        refreshToken,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        email,
        name: displayName,
        scope,
        isDeleted: false,
        status: "installed",
        lastInstalledAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      context: "query",
    },
  ).lean();

  // Agents created before per-store support belong to the user's oldest store.
  await claimLegacyAgentsForOldestStore(resolvedUserId);

  // Same gmail, additional store => this store gets its own agent + widget.
  if (!newUser && !existingStore) {
    const ownAgents = await Agent.countDocuments({
      userId: resolvedUserId,
      storeHash: shopDomain,
      isDeleted: false,
    });
    if (ownAgents === 0) {
      await provisionAgentForStore({
        userId: resolvedUserId,
        storeHash: shopDomain,
      });
    }
  }

  Promise.resolve(
    sendWelcomeEmail(
      email,
      "shopify",
      displayName,
      `https://${shopDomain}`,
      displayName,
      shopAdminAppUrl(shopDomain),
    ),
  ).catch((err) => {
    console.error("[Shopify] Welcome email failed:", err.message || err);
  });

  return store;
}

/**
 * Authorization code grant — kept as the fallback flow for cases where no
 * session token is available (e.g. legacy install links). With Shopify
 * managed installation configured (scopes in the app config, no legacy
 * install flow), merchants normally never hit this route.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */
router.get("/auth/credential-error", async (req, res) => {
  const shop = normalizeShopDomain(req.query.shop);
  if (!shop) return res.status(400).send("Missing shop");
  const incomingId = resolveIncomingClientId(req);
  await uninstallOnCredentialMismatch(shop, req.query.id_token);
  return sendShopifyApplicationNotFound(res, shop, incomingId);
});

router.get("/auth/install", async (req, res) => {
  if (!isShopifyConfigured()) {
    return res.status(500).send("Shopify is not configured");
  }
  const shop = normalizeShopDomain(req.query.shop);
  if (!shop) {
    return res
      .status(400)
      .send("Provide a valid shop query, e.g. ?shop=your-store.myshopify.com");
  }
  const incomingId = resolveIncomingClientId(req);
  if (
    !req.query.hmac ||
    !verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)
  ) {
    // No HMAC, or HMAC from another app. OAuth with any live client_id
    // would install that app on the store even when creds are wrong.
    console.warn("[Shopify] Install HMAC missing/mismatch; refusing OAuth");
    return sendExitToShopifyOauthError(
      res,
      shop,
      req.query.id_token,
      incomingId,
    );
  }
  if (incomingId && incomingId !== SHOPIFY_CLIENT_ID) {
    console.warn(
      "[Shopify] Install client_id does not match SHOPIFY_CLIENT_ID; refusing OAuth",
    );
    return sendExitToShopifyOauthError(
      res,
      shop,
      req.query.id_token,
      incomingId,
    );
  }

  // State is signed for this exact shop; the callback rejects any other shop.
  const state = signOAuthState(shop);
  res.cookie("shopify_oauth_state", state, {
    ...getAuthCookieOptions(req),
    maxAge: OAUTH_STATE_TTL_MS,
    sameSite: "none",
    secure: true,
  });

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(SHOPIFY_CALLBACK_URL)}` +
    `&state=${encodeURIComponent(state)}`;
  return res.redirect(authUrl);
});

router.get("/auth/callback", async (req, res) => {
  if (!isShopifyConfigured()) {
    return res.status(500).json({ message: "Shopify is not configured" });
  }
  const { code, shop, state } = req.query;
  if (!code || !shop) {
    return res.status(400).json({ message: "Missing code or shop" });
  }
  if (!verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)) {
    return sendExitToShopifyOauthError(
      res,
      normalizeShopDomain(shop),
      req.query.id_token,
      resolveIncomingClientId(req),
    );
  }
  const cookieState = req.cookies?.shopify_oauth_state;
  if (!state || (cookieState && state !== cookieState)) {
    return sendInstallError(
      res,
      403,
      "Invalid or expired installation request. Please start the installation again from your store.",
    );
  }

  const shopDomain = normalizeShopDomain(shop);
  if (!shopDomain) {
    return sendInstallError(res, 400, "Invalid shop domain.");
  }

  // The install must complete for the same store it was started for. If not,
  // show an error instead of landing on a previously installed store.
  const stateCheck = verifyOAuthState(state, shopDomain);
  if (!stateCheck.ok) {
    console.warn(
      `[Shopify] OAuth state rejected for ${shopDomain}: ${stateCheck.reason}`,
    );
    return sendInstallError(
      res,
      403,
      stateCheck.reason === "shop_mismatch"
        ? `This installation was started for a different store than ${shopDomain}. Please install the app from the store you are logged in with.`
        : "Installation request expired. Please start the installation again from your store.",
    );
  }

  
  try {
    const { data: tokenData } = await axios.post(
      `https://${shopDomain}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_API_SECRET,
        code,
        expiring: 1,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    const tokens = parseTokenResponse(tokenData);

    await registerAppUninstalledWebhook(shopDomain, tokens.accessToken);
    await upsertInstalledShopifyStore({ shopDomain, ...tokens });

    res.clearCookie("shopify_oauth_state", { path: "/" });
    return res.redirect(shopAdminAppUrl(shopDomain));
  } catch (err) {
    console.error(
      "[Shopify] Install error:",
      err.response?.data || err.message || err,
    );
    if (isInvalidShopifyClientError(err)) {
      return sendExitToShopifyOauthError(
        res,
        shopDomain,
        req.query.id_token,
        resolveIncomingClientId(req),
      );
    }
    return sendInstallError(
      res,
      500,
      `Shopify installation failed for ${shopDomain}. Please try again or contact support.`,
    );
  }
});

/**
 * Embedded app load. Official flow:
 *  1. Verify the session token (id_token) from App Bridge.
 *  2. If no valid offline access token is stored, run token exchange.
 *  3. If the session token is expired/invalid, reply 401 with the
 *     X-Shopify-Retry-Invalid-Session-Request header so App Bridge fetches a
 *     fresh token and retries once.
 */
/**
 * Every /auth/load failure returns { status:false, code, message } so the UI
 * can show the real reason instead of an endless spinner. Messages are
 * user-safe: never include secrets, tokens or stack traces.
 */
function loadError(res, httpStatus, code, message, shop = null, extra = {}) {
  return res.status(httpStatus).json({
    status: false,
    code,
    message,
    ...(shop ? { shop } : {}),
    ...extra,
  });
}

async function credentialMismatchJson(res, shop, idToken, incomingClientId) {
  await uninstallOnCredentialMismatch(shop, idToken);
  const apiKey =
    sanitizeShopifyClientId(incomingClientId) || clientIdFromIdToken(idToken);
  return loadError(
    res,
    403,
    "APP_CREDENTIAL_MISMATCH",
    "Shopify app credentials are invalid.",
    shop,
    {
      ...(apiKey ? { apiKey } : {}),
    },
  );
}

router.get("/auth/load", async (req, res) => {
  if (!isShopifyConfigured()) {
    return loadError(
      res,
      500,
      "SHOPIFY_NOT_CONFIGURED",
      "Shopify integration is not configured on the server.",
    );
  }

  const idToken = req.query.session_token || req.query.id_token;
  const incomingId = resolveIncomingClientId(req, idToken);
  const claimedShop =
    normalizeShopDomain(req.query.shop) ||
    readUnverifiedSessionToken(idToken)?.shop ||
    readUnverifiedSessionToken(req.query.id_token)?.shop;
  let shopDomain = null;
  let hasValidSessionToken = false;

  // HMAC is signed by the app that opened admin. Check it before trusting
  // App Bridge: the frontend api key can mint a valid token for OUR app
  // even when the merchant installed a different one.
  if (req.query.hmac && !verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)) {
    console.warn("[Shopify] Load HMAC mismatch; refusing install");
    return credentialMismatchJson(res, claimedShop, idToken, incomingId);
  }

  if (incomingId && SHOPIFY_CLIENT_ID && incomingId !== SHOPIFY_CLIENT_ID) {
    console.warn(
      "[Shopify] session token aud does not match SHOPIFY_CLIENT_ID; refusing install",
    );
    return credentialMismatchJson(res, claimedShop, idToken, incomingId);
  }

  if (idToken) {
    try {
      ({ shop: shopDomain } = verifySessionToken(idToken));
      hasValidSessionToken = true;
    } catch (e) {
      console.error("[Shopify] session token verify failed:", e.message);
      // Signature / audience failures mean the token was issued by a different
      // Shopify app than the credentials this server uses — retrying is useless.
      if (isCredentialMismatchJwtError(e)) {
        return credentialMismatchJson(
          res,
          claimedShop,
          idToken,
          incomingId,
        );
      }
      res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
      const expired =
        e.name === "TokenExpiredError" || e.name === "NotBeforeError";
      return loadError(
        res,
        401,
        expired ? "SESSION_EXPIRED" : "SESSION_INVALID",
        expired
          ? "Your session has expired. Please reload the page."
          : "Invalid Shopify session. Please reload the page.",
      );
    }
  } else if (req.query.shop && req.query.hmac) {
    shopDomain = normalizeShopDomain(req.query.shop);
  }

  if (!shopDomain) {
    return loadError(
      res,
      400,
      "INVALID_REQUEST",
      "Invalid link. Please open the app again from your Shopify admin.",
    );
  }

  try {
    let store = await Store.findOne({
      storeHash: shopDomain,
      platform: "shopify",
    }).lean();

    // A stored token without a refresh token is a legacy non-expiring token,
    // which the Admin API no longer accepts — exchange for an expiring one.
    let needsAccessToken =
      !store ||
      store.status === "uninstalled" ||
      !store.accessToken ||
      !store.refreshToken;

    // Verify the stored token against Shopify itself (not just "a token
    // exists in the DB"): a revoked/invalid token means the app is no longer
    // installed on this store.
    let tokenRejectedByShopify = false;
    if (!needsAccessToken) {
      try {
        const liveToken = await getValidShopifyAccessToken(store);
        const shopRecord = await fetchShopRecord(shopDomain, liveToken);
        if (normalizeShopDomain(shopRecord?.myshopify_domain) !== shopDomain) {
          throw Object.assign(new Error("Shop domain mismatch"), {
            shopifyRejected: true,
          });
        }
      } catch (verifyErr) {
        const status = verifyErr.response?.status;
        if (
          verifyErr.shopifyRejected ||
          [400, 401, 403, 404].includes(status)
        ) {
          console.warn(
            `[Shopify] Stored token rejected for ${shopDomain}:`,
            verifyErr.response?.data || verifyErr.message,
          );
          needsAccessToken = true;
          tokenRejectedByShopify = true;
        } else {
          // Network / 5xx: don't lock the merchant out because of a blip.
          console.warn(
            "[Shopify] Token verification skipped:",
            verifyErr.message,
          );
        }
      }
    }

    let exchanged = false;
    let exchangeFailed = false;
    if (needsAccessToken && hasValidSessionToken) {
      try {
        const tokens = await exchangeSessionTokenForAccessToken(
          shopDomain,
          idToken,
        );
        await registerAppUninstalledWebhook(shopDomain, tokens.accessToken);
        store = await upsertInstalledShopifyStore({ shopDomain, ...tokens });
        exchanged = true;
      } catch (exchangeErr) {
        exchangeFailed = true;
        console.error(
          "[Shopify] Token exchange failed:",
          exchangeErr.response?.data || exchangeErr.message,
        );
      }
    }

    if (
      !store ||
      store.status === "uninstalled" ||
      !store.accessToken ||
      (tokenRejectedByShopify && !exchanged)
    ) {
      if (tokenRejectedByShopify && !exchanged) {
        return loadError(
          res,
          403,
          "TOKEN_REVOKED",
          "Shopify access was revoked. Please reinstall the app.",
          shopDomain,
        );
      }
      if (exchangeFailed) {
        return loadError(
          res,
          502,
          "EXCHANGE_FAILED",
          "Could not connect your store. Please try again.",
          shopDomain,
        );
      }
      return loadError(
        res,
        403,
        "NOT_INSTALLED",
        "The app is not installed on this store.",
        shopDomain,
      );
    }

    // Agents created before per-store support are handed to the oldest store.
    await claimLegacyAgentsForOldestStore(store.userId);

    const [userData, agents] = await Promise.all([
      User.findById(store.userId).select("_id email isOnboarded"),
      // Only this store's agents — other stores of the same user stay separate.
      Agent.find({
        userId: store.userId,
        storeHash: shopDomain,
        isDeleted: false,
      })
        .select("_id agentName isActive")
        .lean(),
    ]);

    if (!userData) {
      return loadError(
        res,
        403,
        "USER_NOT_FOUND",
        "Your account was not found. Please contact support.",
        shopDomain,
      );
    }

    if (req.io) {
      setImmediate(() =>
        req.io.emit("user-logged-in", { userId: userData._id }),
      );
    }

    // If the agent limit is exceeded and the user isn't onboarded yet, mark
    // them onboarded so the embedded app skips the onboarding wizard.
    // Onboarding is tracked per store. Legacy stores (no flag yet) fall back to
    // the user-level flag, and only they get the agent-limit auto-onboard.
    const isLegacyStore = typeof store.isOnboarded !== "boolean";
    let isOnboarded = isLegacyStore
      ? userData.getIsOnboarded("shopify")
      : store.isOnboarded;
    const [agentLimitExceeded, token] = await Promise.all([
      isOnboarded || !isLegacyStore
        ? Promise.resolve(false)
        : PlanService.isAgentLimitExceeded(store.userId),
      findOrReuseUserSession(userData, "shopify", req, shopDomain),
    ]);

    if (!isOnboarded && isLegacyStore && agentLimitExceeded) {
      isOnboarded = true;
      userData.isOnboarded = userData.isOnboarded || {
        local: false,
        shopify: false,
        bigcommerce: false,
      };
      userData.isOnboarded.shopify = true;
      userData.markModified("isOnboarded");
      await userData.save();
    }

    const cookieOptions = getAuthCookieOptions(req);
    res.cookie("sf_token", token, cookieOptions);
    res.cookie("platform", "shopify", cookieOptions);

    return res.status(200).json({
      status: true,
      userId: userData._id,
      isOnboarded,
      agents,
      shopifyShop: shopDomain,
      token,
    });
  } catch (err) {
    console.error("[Shopify] Load error:", err.message);
    return loadError(
      res,
      500,
      "LOAD_FAILED",
      "Something went wrong while loading the app. Please try again.",
      shopDomain,
    );
  }
});

router.post("/webhooks/app-uninstalled", async (req, res) => {
  if (!SHOPIFY_API_SECRET) {
    return res.status(500).send("Shopify is not configured");
  }
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const raw =
    req.rawBody != null
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body || {}));
  if (!verifyShopifyWebhookHmac(raw, hmacHeader, SHOPIFY_API_SECRET)) {
    return res.status(401).send("Unauthorized");
  }

  let body = req.body;
  if (req.rawBody) {
    try {
      body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      body = {};
    }
  }

  const domain = normalizeShopDomain(
    body.myshopify_domain || body.domain || body.shop_domain,
  );
  if (!domain) {
    return res.status(400).send("Missing shop domain");
  }

  try {
    await Store.findOneAndUpdate(
      { storeHash: domain, platform: "shopify" },
      {
        status: "uninstalled",
        lastUninstalledAt: new Date(),
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      },
    );
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[Shopify] Uninstall webhook failed:", err.message);
    return res.status(500).send("Webhook processing failed");
  }
});

module.exports = router;
module.exports.getValidShopifyAccessToken = getValidShopifyAccessToken;
