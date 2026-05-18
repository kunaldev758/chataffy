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
const { setAuthTokenCookie } = require("../constants/clientCookie.js");
const { sendWelcomeEmail } = require("../services/emailService");

const router = express.Router();


const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES =
  process.env.SHOPIFY_SCOPES || "read_products,read_content";
const SHOPIFY_CALLBACK_URL = `${process.env.BASE_URL}api/shopify/auth/callback`;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

function verifyShopifyQueryHmac(query, secret) {
  if (!secret || !query?.hmac) return false;
  const params = { ...query };
  delete params.hmac;
  delete params.signature;
  const sortedKeys = Object.keys(params).sort();
  const message = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");
  const generated = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
    console.log("generated ->>>>>>>> ", generated);
    console.log("query.hmac ->>>>>>>> ", query.hmac);
    
  try {
    const a = Buffer.from(generated, "utf8");
    const b = Buffer.from(String(query.hmac), "utf8");
    if (a.length !== b.length) return false;
    console.log("a ->>>>>>>> ", generated);
    console.log("returning true from QueryHmac");
    return crypto.timingSafeEqual(a, b);
  } catch {
    console.log("returning false from QueryHmac");
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

function resolveShopifyShopFromLoadRequest(req) {
  const idToken = req.query.id_token; //id_token is the JWT token that is used to verify the Shopify session
  if (idToken && SHOPIFY_API_SECRET && SHOPIFY_CLIENT_ID) {
    try {
      const payload = jwt.verify(idToken, SHOPIFY_API_SECRET, {
        algorithms: ["HS256"],
        audience: SHOPIFY_CLIENT_ID,
      });
      const dest = payload.dest;
      if (dest) {
        const hostname = new URL(dest).hostname;
        if (hostname.endsWith(".myshopify.com")) return hostname.toLowerCase();
      }
    } catch (e) {
      console.error("[Shopify] id_token verify failed:", e.message);
    }
  }
  const q = req.query;
  console.log("q ->>>>>>>> ", q);
  console.log("verifyShopifyQueryHmac ->>>>>>>> ", verifyShopifyQueryHmac(q, SHOPIFY_API_SECRET));
  if (q.shop && q.hmac && verifyShopifyQueryHmac(q, SHOPIFY_API_SECRET)) {
    const shop = String(q.shop).toLowerCase();
    console.log("shop ->>>>>>>> ", shop);
    if (shop.endsWith(".myshopify.com")) return shop;
  }
  return null;
}

router.get("/auth/install", (req, res) => {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_API_SECRET) {
    return res.status(500).send("Shopify is not configured");
  }
  console.log("[Shopify] installing app");
  const shop = String(req.query.shop || "")
    .trim()
    .toLowerCase();
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return res
      .status(400)
      .send("Provide a valid shop query, e.g. ?shop=your-store.myshopify.com");
  }
  const state = crypto.randomBytes(16).toString("hex");
  const cookieOpts = {
    ...getAuthCookieOptions(req),
    maxAge: 10 * 60 * 1000,
  };
  res.cookie("shopify_oauth_state", state, cookieOpts);
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(SHOPIFY_CALLBACK_URL)}` +
    `&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

router.get("/auth/callback", async (req, res) => {
  console.log("shopify in callback req.query ->>>>>>>> ", req.query);
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_API_SECRET) {
    return res.status(500).json({ message: "Shopify is not configured" });
  }
  const { code, shop, state,hmac } = req.query;
  if (!code || !shop) {
    return res.status(400).json({ message: "Missing code or shop" });
  }
  if (!verifyShopifyQueryHmac(req.query, SHOPIFY_API_SECRET)) {
    return res.status(403).send("Invalid HMAC");
  }
  const cookieState = req.cookies?.shopify_oauth_state;
  if (!state) {
    return res.status(403).send("Missing OAuth state");
  }
  if (cookieState && state !== cookieState) {
    return res.status(403).send("OAuth state mismatch");
  }

  try {
    const shopDomain = String(shop).toLowerCase();
    const { data: tokenData } = await axios.post(
      `https://${shopDomain}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_API_SECRET,
        code,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    console.log("tokenData ->>>>>>>> ", tokenData);
    const access_token = tokenData.access_token;
    const scope = tokenData.scope || SHOPIFY_SCOPES;

    // Inside /auth/callback after getting access_token
    try {
      await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          webhook: {
            topic: "app/uninstalled",
            address: `${process.env.BASE_URL}api/shopify/webhooks/app-uninstalled`,
            format: "json",
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[Shopify] Registered uninstall webhook for ${shopDomain}`);
    } catch (webhookError) {
      // If it already exists, Shopify will return a 422 error
      console.log("[Shopify] Webhook registration skipped or failed:", webhookError.response?.data || webhookError.message);
    }

    const { data: shopJson } = await axios.get(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      { headers: { "X-Shopify-Access-Token": access_token } },
    );
    const shopRecord = shopJson.shop;
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

    const [store, existingUser] = await Promise.all([
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
    if (!store && !existingUser) {
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

    await Store.findOneAndUpdate(
      { storeHash: shopDomain },
      {
        $set:{
          platform: "shopify",
          userId: resolvedUserId,
          clientId: newClient?._id || resolvedClient?._id,
          accessToken: access_token,
          email,
          name: displayName,
          scope,
          isDeleted: false,
          status: "installed",
          lastInstalledAt: new Date(),
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    
    console.log("[Shopify] sending welcome mail");
    await sendWelcomeEmail(
      email,
      "shopify",
      displayName,
      `https://${shopDomain}`,
      displayName,
      `https://${shopDomain}/admin/apps/${encodeURIComponent(SHOPIFY_CLIENT_ID)}`,
    );

    res.clearCookie("shopify_oauth_state", { path: "/" });

    const feLoad =
      process.env.SHOPIFY_APP_LOAD_URL ||
      process.env.CLIENT_URL;
    if (feLoad) {
      const base = feLoad.replace(/\/$/, "");
      const qs = new URLSearchParams({
        shop: shopDomain,
        ...(req.query.host ? { host: String(req.query.host) } : {}),
      });
      return res.redirect(`${base}/load?${qs.toString()}`);
    }
    return res.redirect(
      `https://${shopDomain}/admin/apps/${encodeURIComponent(SHOPIFY_CLIENT_ID)}`,
    );
  } catch (err) {
    console.error(
      "[Shopify] Install error:",
      err.response?.data || err.message || err,
    );
    res.status(500).json({
      status: false,
      message: "Shopify installation failed",
    });
  }
});

router.get("/auth/load", async (req, res) => {
  if (!SHOPIFY_API_SECRET) {
    return res.status(500).json({ message: "Shopify is not configured" });
  }

  const shopDomain = resolveShopifyShopFromLoadRequest(req);
  if (!shopDomain) {
    return res.status(400).json({
      status: false,
      message: "Missing or invalid Shopify session.",
    });
  }

  try {
    const store = await Store.findOne({
      storeHash: shopDomain,
      platform: "shopify",
    }).lean();

    // ── 403 = not installed → frontend will redirect to /install ──
    if (!store) {
      return res.status(403).json({
        status: false,
        message: "Store not found. Please install the app from Shopify.",
      });
    }

    // ── 403 = was uninstalled → needs reinstall ───────────────────
    if (store.status === "uninstalled" || !store.accessToken) {
      return res.status(403).json({
        status: false,
        message: "App was uninstalled. Please reinstall from Shopify.",
      });
    }

    const [userData, agents] = await Promise.all([
      User.findById(store.userId).select("_id email isOnboarded"),
      Agent.find({ userId: store.userId, isDeleted: false })
        .select("_id agentName isActive")
        .lean(),
    ]);

    if (!userData) {
      return res.status(403).json({ status: false, message: "User not found" });
    }

    if (req.io) {
      req.io.emit("user-logged-in", { userId: userData._id });
    }

    const token = userData.generateAuthToken();
    userData.auth_token = token;
    await userData.save();

    setAuthTokenCookie(res, req, {
      token,
      platform: "shopify",
      clientId: shopDomain,
      role: "client",
    });

    return res.status(200).json({
      status: true,
      userId: userData._id,
      isOnboarded: userData.isOnboarded,
      agents,
      shopifyShop: shopDomain,
    });
  } catch (err) {
    console.error("[Shopify] Load error:", err.message);
    // ── 401 = token/session issue → frontend will re-authenticate ──
    res.status(401).json({ status: false, message: "Unauthorized" });
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
    console.log("verifyShopifyWebhookHmac failed ->>>>>>>> ");
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
  const domain = String(
    body.myshopify_domain || body.domain || body.shop_domain || "",
  ).toLowerCase();
  if (!domain) {
    console.log("domain not found ->>>>>>>> ");
    return res.status(400).send("Missing shop domain");
  }
  await Store.findOneAndUpdate(
    { storeHash: domain, platform: "shopify" },
    {
      status: "uninstalled",
      lastUninstalledAt: new Date(),
      accessToken: null,
    },
    { new: true },
  );
  res.status(200).send("OK");
});

module.exports = router;
