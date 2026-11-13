const axios = require("axios");
const crypto = require("crypto");
const { encryptSecret, decryptSecret } = require("../../utils/secretCrypto");

const WIX_APP_ID = () => process.env.WIX_APP_ID || process.env.WIX_CLIENT_ID || "";
const WIX_APP_SECRET = () =>
  process.env.WIX_APP_SECRET || process.env.WIX_CLIENT_SECRET || "";

function isWixConfigured() {
  return Boolean(WIX_APP_ID() && WIX_APP_SECRET());
}

function getWixRedirectUri() {
  if (process.env.WIX_REDIRECT_URI) {
    return String(process.env.WIX_REDIRECT_URI).trim();
  }
  const base = String(process.env.BASE_URL || "http://localhost:9000/").replace(
    /\/?$/,
    "/"
  );
  return `${base}api/wix/callback`;
}

function getDashboardBlogUrl() {
  const client =
    process.env.CLIENT_URL ||
    process.env.DASHBOARD_URL ||
    "http://localhost:9001/";
  return `${String(client).replace(/\/?$/, "/")}blog`;
}

function getStateSecret() {
  return (
    process.env.WIX_STATE_SECRET ||
    process.env.JWT_SECRET_KEY ||
    "chataffy-wix-state"
  );
}

/**
 * Signed OAuth state bound to the Chataffy user (nonce.ts.userId.sig).
 */
function signOAuthState(userId) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const ts = Date.now().toString(36);
  const uid = String(userId);
  const sig = crypto
    .createHmac("sha256", getStateSecret())
    .update(`${nonce}|${ts}|${uid}`)
    .digest("hex");
  return `${nonce}.${ts}.${uid}.${sig}`;
}

function verifyOAuthState(state, maxAgeMs = 15 * 60 * 1000) {
  const [nonce, ts, uid, sig] = String(state || "").split(".");
  if (!nonce || !ts || !uid || !sig) {
    return { ok: false, reason: "malformed" };
  }
  const expected = crypto
    .createHmac("sha256", getStateSecret())
    .update(`${nonce}|${ts}|${uid}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  const issuedAt = parseInt(ts, 36);
  if (!issuedAt || Date.now() - issuedAt > maxAgeMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, userId: uid };
}

/**
 * Start Wix app install from Chataffy dashboard (modern OAuth).
 * New Wix apps do NOT use legacy /installer/install + redirectUrl
 * (that causes REDIRECT_URI_MISMATCHED). Use:
 * https://www.wix.com/app-installer?appId=...&postInstallationUrl=...
 * State is embedded on the callback URL so Wix does not need a
 * pre-registered Redirect URL in the Developer Center.
 */
function buildInstallUrl(userId) {
  if (!isWixConfigured()) {
    throw new Error(
      "Wix is not configured. Set WIX_APP_ID and WIX_APP_SECRET on the server."
    );
  }
  const state = signOAuthState(userId);
  const postInstallationUrl = new URL(getWixRedirectUri());
  postInstallationUrl.searchParams.set("state", state);

  const installerUrl = new URL("https://www.wix.com/app-installer");
  installerUrl.searchParams.set("appId", WIX_APP_ID());
  installerUrl.searchParams.set(
    "postInstallationUrl",
    postInstallationUrl.toString()
  );

  return {
    authorizeUrl: installerUrl.toString(),
    state,
  };
}

/**
 * Legacy custom-auth: exchange authorization code for tokens.
 * New apps should rely on instanceId + client_credentials instead.
 */
async function exchangeAuthorizationCode(code) {
  const response = await axios.post(
    "https://www.wixapis.com/oauth/access",
    {
      grant_type: "authorization_code",
      client_id: WIX_APP_ID(),
      client_secret: WIX_APP_SECRET(),
      code,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const msg =
      response.data?.error_description ||
      response.data?.message ||
      `Wix token exchange failed (HTTP ${response.status})`;
    throw new Error(String(msg));
  }

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresIn: Number(response.data.expires_in) || 5 * 60,
  };
}

/**
 * Modern OAuth: create access token with instance_id (valid ~4 hours).
 */
async function createAccessTokenWithInstance(instanceId) {
  const response = await axios.post(
    "https://www.wixapis.com/oauth2/token",
    {
      grant_type: "client_credentials",
      client_id: WIX_APP_ID(),
      client_secret: WIX_APP_SECRET(),
      instance_id: instanceId,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const msg =
      response.data?.error_description ||
      response.data?.message ||
      `Wix access token failed (HTTP ${response.status})`;
    throw new Error(String(msg));
  }

  return {
    accessToken: response.data.access_token,
    expiresIn: Number(response.data.expires_in) || 4 * 60 * 60,
    tokenType: response.data.token_type || "Bearer",
  };
}

/**
 * Legacy: refresh access token using refresh_token grant.
 */
async function refreshAccessToken(refreshTokenPlain) {
  const response = await axios.post(
    "https://www.wixapis.com/oauth/access",
    {
      grant_type: "refresh_token",
      client_id: WIX_APP_ID(),
      client_secret: WIX_APP_SECRET(),
      refresh_token: refreshTokenPlain,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const msg =
      response.data?.error_description ||
      response.data?.message ||
      `Wix token refresh failed (HTTP ${response.status})`;
    throw new Error(String(msg));
  }

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || refreshTokenPlain,
    expiresIn: Number(response.data.expires_in) || 5 * 60,
  };
}

async function fetchAppInstance(accessToken) {
  const response = await axios.get("https://www.wixapis.com/apps/v1/instance", {
    headers: {
      Authorization: accessToken,
      Accept: "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return null;
  }

  return {
    instanceId: response.data?.instance?.instanceId || "",
    siteDisplayName: response.data?.site?.siteDisplayName || "",
    siteUrl:
      response.data?.site?.url ||
      response.data?.site?.siteUrl ||
      response.data?.site?.ownerInfo?.email ||
      "",
    siteId: response.data?.site?.siteId || "",
    permissions: response.data?.instance?.permissions || [],
  };
}

function encryptTokenFields({ accessToken, refreshToken, expiresIn }) {
  const expiresAt = new Date(
    Date.now() + Math.max(60, Number(expiresIn) || 300) * 1000
  );
  return {
    accessToken: accessToken ? encryptSecret(accessToken) : "",
    refreshToken: refreshToken ? encryptSecret(refreshToken) : "",
    expiresAt,
  };
}

function decryptAccessToken(doc) {
  if (!doc?.accessToken) return "";
  return decryptSecret(doc.accessToken);
}

function decryptRefreshToken(doc) {
  if (!doc?.refreshToken) return "";
  return decryptSecret(doc.refreshToken);
}

/**
 * Ensure a valid access token for this Wix connection document.
 * Prefers modern client_credentials(instanceId); falls back to refresh_token.
 */
async function ensureAccessToken(connDoc) {
  const bufferMs = 2 * 60 * 1000;
  const stillValid =
    connDoc.accessToken &&
    connDoc.expiresAt &&
    new Date(connDoc.expiresAt).getTime() - bufferMs > Date.now();

  if (stillValid) {
    return {
      accessToken: decryptAccessToken(connDoc),
      encrypted: null,
    };
  }

  if (connDoc.instanceId) {
    try {
      const token = await createAccessTokenWithInstance(connDoc.instanceId);
      return {
        accessToken: token.accessToken,
        encrypted: encryptTokenFields({
          accessToken: token.accessToken,
          refreshToken: decryptRefreshToken(connDoc) || undefined,
          expiresIn: token.expiresIn,
        }),
      };
    } catch (err) {
      // fall through to refresh token
      if (!connDoc.refreshToken) throw err;
    }
  }

  const refreshPlain = decryptRefreshToken(connDoc);
  if (!refreshPlain) {
    throw new Error(
      "Wix session expired. Disconnect and connect Wix again."
    );
  }

  const refreshed = await refreshAccessToken(refreshPlain);
  return {
    accessToken: refreshed.accessToken,
    encrypted: encryptTokenFields({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresIn: refreshed.expiresIn,
    }),
  };
}

module.exports = {
  isWixConfigured,
  getWixRedirectUri,
  getDashboardBlogUrl,
  signOAuthState,
  verifyOAuthState,
  buildInstallUrl,
  exchangeAuthorizationCode,
  createAccessTokenWithInstance,
  refreshAccessToken,
  fetchAppInstance,
  encryptTokenFields,
  decryptAccessToken,
  decryptRefreshToken,
  ensureAccessToken,
  WIX_APP_ID,
};
