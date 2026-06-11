const jwt = require("jsonwebtoken");
const User = require("../models/User");
const HumanAgent = require("../models/HumanAgent");
const ImpersonationSession = require("../models/ImpersonationSession");
const {
  CLIENT_TOKEN,
  AGENT_TOKEN,
  collectAuthTokenCandidates,
} = require("../constants/authCookies");
const { getAuthCookieOptions } = require("../helpers/helper");
const UserSession = require("../models/userSession");

const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

async function authenticateDecoded(req, res, decoded, token, cookieName) {
  
  if (decoded?.purpose === "impersonation") {
    if (!decoded?._id || !decoded?.jti) {
      return null;
    }
    const session = await ImpersonationSession.findOne({ jti: decoded.jti });
    if (!session || session.revokedAt) {
      return null;
    }
    if (String(session.userId) !== String(decoded._id)) {
      return null;
    }
    if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    req.body.userId = decoded._id;
    req.body.impersonatedBy = session.superAdminId;
    req.body.isImpersonating = true;
    req.authSession = { portal: "client", cookieName, token, platform: "local" };
    return true;
  }

  const userId = decoded._id;
  const user = userId ? await User.findById(userId) : null;
  if (user?.isDeleted) {
    return null;
  }

  const humanAgent = decoded?.id ? await HumanAgent.findById(decoded.id) : null;
  const isHumanAgentJwt =
    decoded?.role === "human-agent" || (humanAgent && !userId);

  const platform = decoded?.platform || "local";

  // For client portals, validate token against UserSession
  if (user) {
    // Check if an active UserSession exists for this token
    const userSession = await UserSession.findOne({
      userId: user._id,
      platform: platform,
      token: token,
    });

    // Session must exist and not be expired
    if (!userSession || (userSession.expiresAt && userSession.expiresAt.getTime() <= Date.now())) {
      return null;
    }

    req.body.userId = userId;
    req.authSession = { portal: "client", cookieName, token, platform, sessionId: userSession._id };
    await maybeRefreshClientSessionExpiry(req, res, userSession);
    return true;
  }

  if (humanAgent && isHumanAgentJwt) {
    req.body.userId = humanAgent.userId;
    req.authSession = { portal: "agent", cookieName, token };
    await maybeRefreshAgentToken(req, res, humanAgent);
    return true;
  }

  return null;
}

async function maybeRefreshClientSessionExpiry(req, res, userSession) {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const decoded = jwt.decode(userSession.token);
  const expiresInSeconds =
    typeof decoded?.exp === "number" ? decoded.exp - nowInSeconds : null;
  const sessionExpiresInMs = userSession.expiresAt
    ? userSession.expiresAt.getTime() - Date.now()
    : null;

  // Refresh session expiry if less than 1 day remaining
  const shouldRefresh =
    typeof sessionExpiresInMs === "number" &&
    sessionExpiresInMs > 0 &&
    sessionExpiresInMs <= ONE_DAY_IN_SECONDS * 1000;

    // console.log("Should refresh client session?", { expiresInSeconds, sessionExpiresInMs, shouldRefresh });
  if (!shouldRefresh) return;

  userSession.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // extend 7 days
  await userSession.save();

  // Refresh JWT token cookie if JWT itself is expiring soon
  if (
    typeof expiresInSeconds === "number" &&
    expiresInSeconds > 0 &&
    expiresInSeconds <= ONE_DAY_IN_SECONDS
  ) {
    const user = await User.findById(userSession.userId);
    if (user) {
      const refreshedToken = user.generateAuthToken(userSession.platform);
      userSession.token = refreshedToken;
      await userSession.save();

      const platformCookieName =
        userSession.platform === "shopify"
          ? "sf_token"
          : userSession.platform === "bigcommerce"
            ? "bc_token"
            : CLIENT_TOKEN;
      const cookieOptions = getAuthCookieOptions(req);
      res.cookie(platformCookieName, refreshedToken, cookieOptions);
      if (userSession.platform === "local") {
        res.cookie(CLIENT_TOKEN, refreshedToken, cookieOptions);
      }
    }
  }
}

async function maybeRefreshAgentToken(req, res, humanAgent) {
  const cookieOptions = getAuthCookieOptions(req);
  const refreshedToken = jwt.sign(
    { id: humanAgent._id, email: humanAgent.email, role: "human-agent" },
    process.env.JWT_SECRET_KEY,
    { expiresIn: "7d" },
  );
  res.cookie(AGENT_TOKEN, refreshedToken, cookieOptions);
  
  // Also create/update UserSession for agent tokens for audit/tracking
  const UserSession = require("../models/UserSession");
  await UserSession.updateOne(
    { userId: humanAgent.userId, portal: "agent", token: req.authSession?.token },
    {
      $set: {
        token: refreshedToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    },
    { upsert: true },
  );
}

module.exports = async (req, res, next) => {
  const candidates = collectAuthTokenCandidates(req);

  for (const { name, token } of candidates) {
    if (!token) continue;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      if (!decoded?._id && !decoded?.id) continue;

      const ok = await authenticateDecoded(req, res, decoded, token, name);
      if (ok) {
        return next();
      }
    } catch {
      /* try next candidate */
    }
  }

  return res.status(401).json({
    status_code: 401,
    error: "Authentication failed. No valid token provided.",
  });
};
