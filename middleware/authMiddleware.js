const jwt = require('jsonwebtoken');
const util = require('util');
const User = require('../models/User');
const HumanAgent = require('../models/HumanAgent');
const ImpersonationSession = require('../models/ImpersonationSession');
const {
  extractAuthTokens,
  setAuthTokenCookie,
  resolvePlatform,
  resolveClientId,
  getRequestSessionPlatform,
} = require('../constants/clientCookie.js');
const {
  validateUserSession,
  refreshSessionToken,
  orderAuthTokensByPlatform,
  refreshFromExpiredJwt,
} = require('../services/userSessionService.js');

const verifyJwt = util.promisify(jwt.verify);
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

function getPreferredAuthPlatform(req) {
  return (
    req?.headers?.['x-chataffy-platform'] ||
    req?.body?.platform ||
    req?.query?.platform ||
    null
  );
}

async function applyUserSessionSuccess(req, res, user, session, activeToken, decoded) {
  req.body.userId = user._id;
  req.session = session;
  req.authToken = activeToken;

  // IMPORTANT: reuse sessions without minting new JWTs on reload/redirect.
  // Token rotation happens only via explicit refresh endpoint or expired-token refresh.
  return { ok: true };
}

async function authenticateRequest(req, res) {
  let tokens = extractAuthTokens(req);
  if (!tokens.length) {
    return { ok: false, status: 401, error: 'Authentication failed. No token provided.' };
  }

  const preferredPlatform = getPreferredAuthPlatform(req);
  if (preferredPlatform) {
    tokens = await orderAuthTokensByPlatform(tokens, preferredPlatform);
  }

  const strictPlatform = getRequestSessionPlatform(req);
  let lastError = null;

  for (const token of tokens) {
    try {
      let decoded;
      let activeToken = token;

      try {
        decoded = await verifyJwt(token, process.env.JWT_SECRET_KEY);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          const refreshed = await refreshFromExpiredJwt(token, req, res);
          if (!refreshed) {
            lastError = err;
            continue;
          }

          decoded = refreshed.decoded;
          activeToken = refreshed.token;

          const { session } = refreshed;
          if (session && strictPlatform && session.platform !== strictPlatform) {
            lastError = err;
            continue;
          }

          return await applyUserSessionSuccess(
            req,
            res,
            refreshed.user,
            session,
            activeToken,
            decoded,
          );
        }
        lastError = err;
        continue;
      }

      if (decoded?.purpose === 'impersonation') {
        if (!decoded?._id || !decoded?.jti) {
          continue;
        }
        const session = await ImpersonationSession.findOne({ jti: decoded.jti });
        if (!session || session.revokedAt) continue;
        if (String(session.userId) !== String(decoded._id)) continue;
        if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) continue;

        req.body.userId = decoded._id;
        req.body.impersonatedBy = session.superAdminId;
        req.body.isImpersonating = true;
        return { ok: true };
      }

      const userId = decoded._id;
      const user = userId ? await User.findById(userId) : null;
      if (user?.isDeleted) continue;

      const humanAgent = decoded?.id ? await HumanAgent.findById(decoded.id) : null;

      if (user) {
        const { valid, session, legacy } = await validateUserSession(user, decoded, activeToken);
        if (!valid) continue;

        if (session && !legacy && strictPlatform && session.platform !== strictPlatform) {
          continue;
        }

        return await applyUserSessionSuccess(req, res, user, session, activeToken, decoded);
      }

      if (humanAgent) {
        req.body.userId = humanAgent.userId;
        req.authToken = activeToken;
        return { ok: true };
      }
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    status: 401,
    error: lastError?.name === 'TokenExpiredError'
      ? 'Authentication failed. Token expired.'
      : 'Authentication failed. Invalid token.',
  };
}

const authMiddleware = async (req, res, next) => {
  try {
    const result = await authenticateRequest(req, res);
    if (!result.ok) {
      return res.status(result.status).json({ status_code: result.status, error: result.error });
    }
    return next();
  } catch (error) {
    console.log('auth middleware error ----> ', error);
    return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
  }
};

authMiddleware.authenticateRequest = authenticateRequest;
module.exports = authMiddleware;
