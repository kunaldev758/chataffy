const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const util = require("util");
const UserSession = require("../models/UserSession.model.js");
const Client = require("../models/Client");
const User = require("../models/User.js");
const {
  resolvePlatform,
  resolveClientId,
  sanitizeClientId,
  getPlatformCookieName,
  setAuthTokenCookie,
  extractAuthToken,
  clearSessionAuthCookie,
} = require("../constants/clientCookie.js");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const verifyJwt = util.promisify(jwt.verify);

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function generateSessionId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

async function resolveWebClientId(userId, clientId) {
  if (clientId) {
    return sanitizeClientId(clientId);
  }
  const client = await Client.findOne({ userId }).select("_id").lean();
  return sanitizeClientId(client?._id?.toString() || "default");
}

/**
 * Create a new session on every login (supports multiple concurrent sessions).
 */
async function createSessionAndToken(
  user,
  { platform = "web", clientId, req } = {},
) {
  const resolvedPlatform = platform || (req ? resolvePlatform(req) : "web");
  const resolvedClientId =
    resolvedPlatform === "web"
      ? await resolveWebClientId(user._id, clientId ?? (req && resolveClientId(req, { platform: resolvedPlatform })))
      : sanitizeClientId(
          clientId ?? (req && resolveClientId(req, { platform: resolvedPlatform })),
        );

  const sessionId = generateSessionId();
  const token = user.generateAuthToken({
    sessionId,
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    storeHash: resolvedPlatform === "bigcommerce" ? resolvedClientId : undefined,
    shopDomain: resolvedPlatform === "shopify" ? resolvedClientId : undefined,
  });
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await UserSession.create({
    userId: user._id,
    sessionId,
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    tokenHash: hashToken(token),
    isActive: true,
    expiresAt,
  });

  return {
    token,
    sessionId,
    platform: resolvedPlatform,
    clientId: resolvedClientId,
    expiresAt,
  };
}

function getSessionIdFromDecoded(decoded) {
  return decoded?.sessionId || decoded?.sid || null;
}

/**
 * Login helper: create session, set cookies, return token metadata.
 * Reuses an existing valid session when cookie/session matches the same user+platform+store.
 */
async function establishUserSession({
  user,
  req,
  res,
  platform,
  clientId,
  role = "client",
}) {
  // 1) Try reuse for same browser + same user + same platform/store
  if (req && res) {
    const resolvedPlatform = platform || resolvePlatform(req);
    const resolvedClientId =
      resolvedPlatform === "web"
        ? await resolveWebClientId(user._id, clientId ?? resolveClientId(req, { platform: resolvedPlatform }))
        : sanitizeClientId(clientId ?? resolveClientId(req, { platform: resolvedPlatform }));

    const cookieName = getPlatformCookieName({
      platform: resolvedPlatform,
      clientId: resolvedClientId,
      shopDomain: resolvedPlatform === "shopify" ? resolvedClientId : undefined,
      storeHash: resolvedPlatform === "bigcommerce" ? resolvedClientId : undefined,
    });
    const rawToken = req?.cookies?.[cookieName] || req?.cookies?.token || null;

    if (rawToken) {
      try {
        const decoded = await verifyJwt(rawToken, process.env.JWT_SECRET_KEY);
        const decodedUserId = decoded?._id || decoded?.userId;
        if (String(decodedUserId) === String(user._id)) {
          const sid = getSessionIdFromDecoded(decoded);
          const existing = sid ? await findActiveSession(sid, user._id) : null;
          if (existing && existing.tokenHash === hashToken(rawToken)) {
            // Reuse: do not mint a new JWT, do not create a new DB session, do not rewrite cookie.
            return {
              token: rawToken,
              sessionId: existing.sessionId,
              platform: existing.platform,
              clientId: existing.clientId,
              expiresAt: existing.expiresAt,
              reused: true,
            };
          }
        } else if (decodedUserId) {
          // Different user in same browser cookie: revoke + clear and create new.
          const sid = getSessionIdFromDecoded(decoded);
          if (sid) {
            await UserSession.updateOne(
              { sessionId: sid, userId: decodedUserId },
              { isActive: false },
            );
          }
          clearSessionAuthCookie(res, req, {
            platform: resolvedPlatform,
            clientId: resolvedClientId,
          });
        }
      } catch {
        // Invalid token: clear cookie and fall through to create new.
        clearSessionAuthCookie(res, req, {
          platform: platform || resolvePlatform(req),
          clientId: clientId || resolveClientId(req),
        });
      }
    }
  }

  const session = await createSessionAndToken(user, { platform, clientId, req });

  if (res) {
    setAuthTokenCookie(res, req, {
      token: session.token,
      platform: session.platform,
      clientId: session.clientId,
      sessionId: session.sessionId,
      role,
    });
  }

  return session;
}

async function findActiveSession(sessionId, userId) {
  if (!sessionId) {
    return null;
  }

  return UserSession.findOne({
    sessionId,
    userId,
    isActive: true,
    expiresAt: { $gt: new Date() },
  });
}



/**
 * Validate JWT against UserSession (supports legacy auth_token fallback).
 */


async function validateUserSession(user, decoded, rawToken) {
  if (!user || !rawToken) {
    return { valid: false, session: null };
  }

  const sid = getSessionIdFromDecoded(decoded);
  if (sid) {
    const session = await findActiveSession(sid, user._id);
    if (!session) {
      return { valid: false, session: null };
    }
    if (session.tokenHash !== hashToken(rawToken)) {
      return { valid: false, session: null };
    }
    return { valid: true, session };
  }

  if (user.auth_token && user.auth_token === rawToken) {
    return { valid: true, session: null, legacy: true };
  }

  return { valid: false, session: null };
}

async function refreshSessionToken(user, session) {
  const sessionId = session?.sessionId;
  if (!sessionId) {
    return user.generateAuthToken();
  }

  const token = user.generateAuthToken({
    sessionId,
    platform: session.platform,
    clientId: session.clientId,
    storeHash: session.platform === "bigcommerce" ? session.clientId : undefined,
    shopDomain: session.platform === "shopify" ? session.clientId : undefined,
  });
  session.tokenHash = hashToken(token);
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  session.isActive = true;
  await session.save();

  return token;
}

/**
 * JWT clock expired but DB session still active: verify signature (ignore exp),
 * validate session + token hash, rotate JWT and set cookie.
 */
async function refreshFromExpiredJwt(rawToken, req, res) {
  if (!rawToken || !process.env.JWT_SECRET_KEY) {
    return null;
  }

  let decoded;
  try {
    decoded = await verifyJwt(rawToken, process.env.JWT_SECRET_KEY, {
      ignoreExpiration: true,
    });
  } catch {
    return null;
  }

  if (
    decoded?.purpose === "impersonation" ||
    decoded?.purpose === "email_verification"
  ) {
    return null;
  }

  const userId = decoded._id;
  const sid = getSessionIdFromDecoded(decoded);
  if (!userId || !sid) {
    return null;
  }

  const user = await User.findById(userId);
  if (!user || user.isDeleted) {
    return null;
  }

  const { valid, session, legacy } = await validateUserSession(
    user,
    decoded,
    rawToken,
  );
  if (!valid || legacy || !session) {
    return null;
  }

  const refreshedToken = await refreshSessionToken(user, session);
  let freshDecoded;
  try {
    freshDecoded = await verifyJwt(refreshedToken, process.env.JWT_SECRET_KEY);
  } catch {
    return null;
  }

  setAuthTokenCookie(res, req, {
    token: refreshedToken,
    platform: session.platform,
    clientId: session.clientId,
    sessionId: session.sessionId,
    role: "client",
  });

  return {
    user,
    session,
    token: refreshedToken,
    decoded: freshDecoded,
  };
}

async function revokeSessionByToken(userId, rawToken) {
  if (!rawToken) {
    return;
  }

  let decoded;
  try {
    decoded = jwt.decode(rawToken);
  } catch {
    return;
  }

  if (decoded?.sid) {
    await UserSession.updateOne(
      { sessionId: decoded.sid, userId },
      { isActive: false },
    );
  }
}

/**
 * Prefer tokens whose UserSession.platform matches (e.g. logout only the web redirect session).
 */
async function orderAuthTokensByPlatform(tokens, platform) {
  if (!platform || tokens.length <= 1) {
    return tokens;
  }

  const ranked = await Promise.all(
    tokens.map(async (token) => {
      let decoded;
      try {
        decoded = jwt.decode(token);
      } catch {
        return { token, rank: 2 };
      }

      if (!decoded?.sid) {
        return { token, rank: platform === "web" ? 0 : 2 };
      }

      const session = await UserSession.findOne({ sessionId: decoded.sid })
        .select("platform")
        .lean();

      return {
        token,
        rank: session?.platform === platform ? 0 : 1,
      };
    }),
  );

  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((entry) => entry.token);
}

async function revokeSessionFromRequest(user, req, res) {
  const token = req.authToken || extractAuthToken(req);
  const session = req.session;

  if (session?.sessionId) {
    await UserSession.updateOne(
      { sessionId: session.sessionId, userId: user._id },
      { isActive: false },
    );
  } else {
    await revokeSessionByToken(user._id, token);
  }

  if (res) {
    let decoded;
    try {
      decoded = jwt.decode(token);
    } catch {
      decoded = null;
    }

    const sessionId = session?.sessionId || decoded?.sid;
    const dbSession =
      session ||
      (sessionId
        ? await UserSession.findOne({
            sessionId,
            userId: user._id,
          }).lean()
        : null);

    clearSessionAuthCookie(res, req, {
      platform: dbSession?.platform || resolvePlatform(req),
      clientId: dbSession?.clientId || resolveClientId(req),
      sessionId,
    });
  }
}

async function revokeAllUserSessions(userId) {
  await UserSession.updateMany({ userId, isActive: true }, { isActive: false });
}

async function listActiveSessions(userId) {
  return UserSession.find({
    userId,
    isActive: true,
    expiresAt: { $gt: new Date() },
  })
    .select("sessionId platform clientId createdAt expiresAt")
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  SESSION_TTL_MS,
  hashToken,
  createSessionAndToken,
  establishUserSession,
  findActiveSession,
  validateUserSession,
  refreshSessionToken,
  refreshFromExpiredJwt,
  revokeSessionByToken,
  orderAuthTokensByPlatform,
  revokeSessionFromRequest,
  revokeAllUserSessions,
  listActiveSessions,
};
