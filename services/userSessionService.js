const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const UserSession = require("../models/UserSession.model.js");
const Client = require("../models/Client");
const {
  resolvePlatform,
  resolveClientId,
  sanitizeClientId,
  setAuthTokenCookie,
  extractAuthToken,
  clearSessionAuthCookie,
} = require("../constants/clientCookie.js");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  const token = user.generateAuthToken(sessionId);
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

/**
 * Login helper: create session, set cookies, return token metadata.
 */
async function establishUserSession({
  user,
  req,
  res,
  platform,
  clientId,
  role = "client",
}) {
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

  if (decoded?.sid) {
    const session = await findActiveSession(decoded.sid, user._id);
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

  const token = user.generateAuthToken(sessionId);
  session.tokenHash = hashToken(token);
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  session.isActive = true;
  await session.save();

  return token;
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
  revokeSessionByToken,
  orderAuthTokensByPlatform,
  revokeSessionFromRequest,
  revokeAllUserSessions,
  listActiveSessions,
};
