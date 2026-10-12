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

function verifyShopifyQueryHmac(query, secret) {
  if (!secret || !query?.hmac) return false;
  const params = { ...query };
  delete params.hmac;
  delete params.signature;
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

async function findOrReuseUserSession(user, platform, req) {
  const existing = await UserSession.findOne({
    userId: user._id,
    platform,
  }).lean();
  if (
    existing &&
    (!existing.expiresAt || existing.expiresAt.getTime() > Date.now())
  ) {
    return existing.token;
  }

  const token = user.generateAuthToken(platform);
  await UserSession.create({
    userId: user._id,
    platform,
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
 * Official token exchange: swap a valid session token (id_token) for an
 * offline access token. Shopify returns 400 if the session token is invalid.
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
    },
    { headers: { "Content-Type": "application/json", Accept: "application/json" } },
  );
  return {
    accessToken: data.access_token,
    scope: data.scope || SHOPIFY_SCOPES,
  };
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
 * Resolve/create the merchant user and upsert the Store record after an
 * access token is obtained (via token exchange or authorization code grant).
 */
async function upsertInstalledShopifyStore({ shopDomain, accessToken, scope }) {
  const shopRecord = await fetchShopRecord(shopDomain, accessToken);
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

  if (existingUser) {
    resolvedClient = await Client.findOne({
      $or: [{ userId: existingUser._id }, { email }],
    }).lean();
  }
  if (!existingStore && !existingUser) {
    const provisioned = await provisionNewMerchantUser({
      email,
      name: displayName,
      provider: "shopify",
    });
    newUser = provisioned.newUser;
    newClient = provisioned.newClient;
  }

  const resolvedUserId = newUser?._id || existingUser?._id;
  if (!resolvedUserId) {
    throw new Error("Could not resolve user for Shopify install");
  }

  const store = await Store.findOneAndUpdate(
    { storeHash: shopDomain },
    {
      $set: {
        platform: "shopify",
        userId: resolvedUserId,
        clientId: newClient?._id || resolvedClient?._id,
        accessToken,
        email,
        name: displayName,
        scope,
        isDeleted: false,
        status: "installed",
        lastInstalledAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

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
router.get("/auth/install", (req, res) => {
  if (!isShopifyConfigured()) {
    return res.status(500).send("Shopify is not configured");
  }
  const shop = normalizeShopDomain(req.query.shop);
  if (!shop) {
    return res
      .status(400)
      .send("Provide a valid shop query, e.g. ?shop=your-store.myshopify.com");
  }
  if (req.query.hmac && !verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)) {
    return res.status(403).send("Invalid HMAC");
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("shopify_oauth_state", state, {
    ...getAuthCookieOptions(req),
    maxAge: 10 * 60 * 1000,
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
    return res.status(403).send("Invalid HMAC");
  }
  const cookieState = req.cookies?.shopify_oauth_state;
  if (!state || (cookieState && state !== cookieState)) {
    return res.status(403).send("Invalid OAuth state");
  }

  const shopDomain = normalizeShopDomain(shop);
  if (!shopDomain) {
    return res.status(400).json({ message: "Invalid shop domain" });
  }

  try {
    const { data: tokenData } = await axios.post(
      `https://${shopDomain}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_API_SECRET,
        code,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    const accessToken = tokenData.access_token;
    const scope = tokenData.scope || SHOPIFY_SCOPES;

    await registerAppUninstalledWebhook(shopDomain, accessToken);
    await upsertInstalledShopifyStore({ shopDomain, accessToken, scope });

    res.clearCookie("shopify_oauth_state", { path: "/" });
    return res.redirect(shopAdminAppUrl(shopDomain));
  } catch (err) {
    console.error(
      "[Shopify] Install error:",
      err.response?.data || err.message || err,
    );
    return res
      .status(500)
      .json({ status: false, message: "Shopify installation failed" });
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
router.get("/auth/load", async (req, res) => {
  if (!isShopifyConfigured()) {
    return res.status(500).json({ message: "Shopify is not configured" });
  }

  const idToken = req.query.id_token;
  let shopDomain = null;
  let hasValidSessionToken = false;

  if (idToken) {
    try {
      ({ shop: shopDomain } = verifySessionToken(idToken));
      hasValidSessionToken = true;
    } catch (e) {
      console.error("[Shopify] session token verify failed:", e.message);
      res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
      return res.status(401).json({
        status: false,
        message: "Invalid or expired Shopify session token.",
      });
    }
  } else if (
    req.query.shop &&
    req.query.hmac &&
    verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)
  ) {
    // HMAC-signed load request (no App Bridge session token available yet).
    shopDomain = normalizeShopDomain(req.query.shop);
  }

  if (!shopDomain) {
    return res.status(400).json({
      status: false,
      message: "Missing or invalid Shopify session.",
    });
  }

  try {
    let store = await Store.findOne({
      storeHash: shopDomain,
      platform: "shopify",
    }).lean();

    const needsAccessToken =
      !store || store.status === "uninstalled" || !store.accessToken;

    if (needsAccessToken && hasValidSessionToken) {
      try {
        const { accessToken, scope } =
          await exchangeSessionTokenForAccessToken(shopDomain, idToken);
        await registerAppUninstalledWebhook(shopDomain, accessToken);
        store = await upsertInstalledShopifyStore({
          shopDomain,
          accessToken,
          scope,
        });
      } catch (exchangeErr) {
        console.error(
          "[Shopify] Token exchange failed:",
          exchangeErr.response?.data || exchangeErr.message,
        );
      }
    }

    if (!store || store.status === "uninstalled" || !store.accessToken) {
      return res.status(403).json({
        status: false,
        message: "App is not installed. Please install it from Shopify.",
      });
    }

    const [userData, agents] = await Promise.all([
      User.findById(store.userId).select("_id email isOnboarded"),
      Agent.find({ userId: store.userId, isDeleted: false })
        .select("_id agentName isActive")
        .lean(),
    ]);

    if (!userData) {
      return res
        .status(403)
        .json({ status: false, message: "User not found" });
    }

    if (req.io) {
      setImmediate(() =>
        req.io.emit("user-logged-in", { userId: userData._id }),
      );
    }

    // If the agent limit is exceeded and the user isn't onboarded yet, mark
    // them onboarded so the embedded app skips the onboarding wizard.
    let isOnboarded = userData.getIsOnboarded("shopify");
    const [agentLimitExceeded, token] = await Promise.all([
      isOnboarded
        ? Promise.resolve(false)
        : PlanService.isAgentLimitExceeded(store.userId),
      findOrReuseUserSession(userData, "shopify", req),
    ]);

    if (!isOnboarded && agentLimitExceeded) {
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
    return res
      .status(401)
      .json({ status: false, message: "Unauthorized" });
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
      },
    );
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[Shopify] Uninstall webhook failed:", err.message);
    return res.status(500).send("Webhook processing failed");
  }
});

module.exports = router;
