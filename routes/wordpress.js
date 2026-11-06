const express = require("express");
const axios = require("axios");
const middleware = require("../middleware/authMiddleware");
const Store = require("../models/Store");
const Client = require("../models/Client");
const User = require("../models/User");
const { encryptSecret } = require("../utils/secretCrypto");

const router = express.Router();

const WP_SCOPE = "wp_rest";

router.use((req, _res, next) => {
  if (!req.body || typeof req.body !== "object") req.body = {};
  next();
});

function sessionUserId(req) {
  return req.body?.userId || null;
}

/**
 * Normalize a WordPress site URL and derive a unique storeHash.
 * Examples: https://example.com → wp:example.com
 *           https://www.example.com/blog/ → wp:example.com/blog
 */
function normalizeWordPressSite(siteUrl) {
  const raw = String(siteUrl || "").trim();
  if (!raw) {
    throw Object.assign(new Error("siteUrl is required"), { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw Object.assign(new Error("Invalid siteUrl"), { status: 400 });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("siteUrl must be http or https"), {
      status: 400,
    });
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) {
    throw Object.assign(new Error("Invalid siteUrl hostname"), { status: 400 });
  }

  // Strip admin / login paths so REST calls hit the site root, not /wp-admin.
  let path = parsed.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(wp-admin|admin|wp-login\.php)(\/.*)?$/i, "");
  path = path.replace(/\/+$/, "");

  const origin = `${parsed.protocol}//${parsed.host}${path || ""}`;
  const storeHash =
    path && path !== "/" ? `wp:${host}${path}` : `wp:${host}`;

  return { siteUrl: origin, storeHash, host };
}

function basicAuthHeader(username, appPassword) {
  const token = Buffer.from(
    `${username}:${String(appPassword).replace(/\s+/g, "")}`,
    "utf8",
  ).toString("base64");
  return `Basic ${token}`;
}

/**
 * Validate credentials against the WordPress REST API.
 * Uses /wp-json/wp/v2/users/me (requires Application Password).
 */
async function validateWordPressCredentials({ siteUrl, username, appPassword }) {
  const url = `${siteUrl.replace(/\/+$/, "")}/wp-json/wp/v2/users/me?context=edit`;
  try {
    const { data, status } = await axios.get(url, {
      headers: {
        Authorization: basicAuthHeader(username, appPassword),
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (status === 401 || status === 403) {
      throw Object.assign(
        new Error(
          "WordPress rejected these credentials. Check username and Application Password, and ensure the REST API is not blocked.",
        ),
        { status: 401, code: "WP_AUTH_FAILED" },
      );
    }

    if (status === 404) {
      throw Object.assign(
        new Error(
          "WordPress REST API not found. Confirm the site URL and that REST API is enabled.",
        ),
        { status: 404, code: "WP_REST_MISSING" },
      );
    }

    if (status < 200 || status >= 300 || !data?.id) {
      throw Object.assign(
        new Error(
          `Could not validate WordPress site (HTTP ${status}).`,
        ),
        { status: 502, code: "WP_VALIDATE_FAILED" },
      );
    }

    const caps = data.capabilities || {};
    const canPublish =
      Boolean(caps.publish_posts) ||
      Boolean(caps.edit_posts) ||
      data.roles?.includes?.("administrator") ||
      data.roles?.includes?.("editor") ||
      data.roles?.includes?.("author");

    if (!canPublish) {
      throw Object.assign(
        new Error(
          "This WordPress user cannot create posts. Use an account with Author, Editor, or Administrator role.",
        ),
        { status: 403, code: "WP_INSUFFICIENT_CAPS" },
      );
    }

    return {
      wpUserId: data.id,
      displayName:
        data.name || data.slug || username,
      email: data.email || null,
      roles: Array.isArray(data.roles) ? data.roles : [],
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      throw Object.assign(
        new Error("Could not reach the WordPress site. Check the site URL."),
        { status: 502, code: "WP_UNREACHABLE" },
      );
    }
    throw Object.assign(
      new Error(error.message || "WordPress validation failed"),
      { status: 502, code: "WP_VALIDATE_FAILED" },
    );
  }
}

async function resolveClientForUser(userId) {
  let client = await Client.findOne({ userId }).lean();
  if (client) return client;

  const user = await User.findById(userId).select("email").lean();
  if (user?.email) {
    client = await Client.findOne({ email: user.email }).lean();
    if (client) return client;
    client = await Client.create({ userId, email: user.email });
    return client.toObject ? client.toObject() : client;
  }

  throw Object.assign(
    new Error("No client profile found for this account"),
    { status: 400, code: "CLIENT_MISSING" },
  );
}

/**
 * POST /api/wordpress/connect
 * Body: { siteUrl, username, appPassword, name? }
 */
async function connectWordPress(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const {
      siteUrl: rawSiteUrl,
      username,
      appPassword,
      name,
    } = req.body || {};

    const wpUsername = String(username || "").trim();
    const password = String(appPassword || "").trim();
    if (!wpUsername || !password) {
      return res.status(400).json({
        status: false,
        message: "username and appPassword are required",
      });
    }

    const { siteUrl, storeHash } = normalizeWordPressSite(rawSiteUrl);
    const validated = await validateWordPressCredentials({
      siteUrl,
      username: wpUsername,
      appPassword: password,
    });

    const client = await resolveClientForUser(userId);
    const user = await User.findById(userId).select("email").lean();
    const email =
      validated.email ||
      user?.email ||
      `wp-${storeHash.replace(/[^a-z0-9]/gi, "")}@wordpress.local`;

    const encryptedPassword = encryptSecret(password.replace(/\s+/g, ""));
    const displayName =
      String(name || "").trim() ||
      validated.displayName ||
      siteUrl;

    const existing = await Store.findOne({ storeHash }).lean();
    if (existing && String(existing.userId) !== String(userId)) {
      return res.status(409).json({
        status: false,
        message: "This WordPress site is already connected to another account",
        code: "SITE_OWNED",
      });
    }

    const store = await Store.findOneAndUpdate(
      { storeHash },
      {
        $setOnInsert: { isOnboarded: true },
        $set: {
          platform: "wordpress",
          userId,
          clientId: client._id,
          storeUrl: siteUrl,
          accessToken: encryptedPassword,
          wpUsername,
          refreshToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          email: String(email).toLowerCase(),
          name: displayName,
          scope: WP_SCOPE,
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

    return res.json({
      status: true,
      message: "WordPress site connected",
      site: {
        storeHash: store.storeHash,
        storeUrl: store.storeUrl,
        platform: "wordpress",
        name: store.name,
        wpUsername: store.wpUsername,
        canPublish: true,
        missingScope: null,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error("[wordpress] connect failed:", error.message);
    }
    return res.status(status).json({
      status: false,
      message: error.message || "Could not connect WordPress site",
      code: error.code || undefined,
    });
  }
}

/**
 * POST /api/wordpress/validate
 * Soft check without persisting — useful from the dashboard before save.
 */
async function validateWordPress(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const { siteUrl: rawSiteUrl, username, appPassword } = req.body || {};
    const wpUsername = String(username || "").trim();
    const password = String(appPassword || "").trim();
    if (!wpUsername || !password) {
      return res.status(400).json({
        status: false,
        message: "username and appPassword are required",
      });
    }

    const { siteUrl, storeHash } = normalizeWordPressSite(rawSiteUrl);
    const validated = await validateWordPressCredentials({
      siteUrl,
      username: wpUsername,
      appPassword: password,
    });

    return res.json({
      status: true,
      message: "WordPress credentials are valid",
      siteUrl,
      storeHash,
      displayName: validated.displayName,
      roles: validated.roles,
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      status: false,
      message: error.message || "Validation failed",
      code: error.code || undefined,
    });
  }
}

/**
 * DELETE /api/wordpress/:storeHash
 * Disconnect (uninstall) a WordPress site for this merchant.
 */
async function disconnectWordPress(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const storeHash = decodeURIComponent(req.params.storeHash || "").trim();
    if (!storeHash || !storeHash.startsWith("wp:")) {
      return res.status(400).json({
        status: false,
        message: "Invalid WordPress storeHash",
      });
    }

    const store = await Store.findOne({
      storeHash,
      userId,
      platform: "wordpress",
    });

    if (!store) {
      return res.status(404).json({ status: false, message: "Site not found" });
    }

    store.status = "uninstalled";
    store.accessToken = null;
    store.wpUsername = null;
    store.lastUninstalledAt = new Date();
    await store.save();

    return res.json({
      status: true,
      message: "WordPress site disconnected",
      storeHash,
    });
  } catch (error) {
    console.error("[wordpress] disconnect failed:", error.message);
    return res.status(500).json({
      status: false,
      message: "Could not disconnect WordPress site",
    });
  }
}

router.post("/connect", middleware, connectWordPress);
router.post("/validate", middleware, validateWordPress);
router.delete("/:storeHash", middleware, disconnectWordPress);

module.exports = router;
module.exports.normalizeWordPressSite = normalizeWordPressSite;
module.exports.WP_SCOPE = WP_SCOPE;
