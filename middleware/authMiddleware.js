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
    req.authSession = { portal: "client", cookieName, token };
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
  const platformTokenField =
    platform === "shopify"
      ? "sf_token"
      : platform === "bigcommerce"
        ? "bc_token"
        : "auth_token";

  if (user && user[platformTokenField] === token) {
    req.body.userId = userId;
    req.authSession = { portal: "client", cookieName, token };
    await maybeRefreshClientToken(req, res, user, platform, platformTokenField);
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

async function maybeRefreshClientToken(req, res, user, platform, platformTokenField) {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const decoded = jwt.decode(user[platformTokenField]);
  const expiresInSeconds =
    typeof decoded?.exp === "number" ? decoded.exp - nowInSeconds : null;
  const shouldRefresh =
    typeof expiresInSeconds === "number" &&
    expiresInSeconds > 0 &&
    expiresInSeconds <= ONE_DAY_IN_SECONDS;

  if (!shouldRefresh) return;

  const refreshedToken = user.generateAuthToken(platform);
  user[platformTokenField] = refreshedToken;
  await user.save();

  const platformCookieName =
    platform === "shopify"
      ? "sf_token"
      : platform === "bigcommerce"
        ? "bc_token"
        : CLIENT_TOKEN;
  const cookieOptions = getAuthCookieOptions(req);
  res.cookie(platformCookieName, refreshedToken, cookieOptions);
  if (platform === "local") {
    res.cookie(CLIENT_TOKEN, refreshedToken, cookieOptions);
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
