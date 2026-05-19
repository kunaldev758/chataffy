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
} = require('../constants/clientCookie.js');
const {
  validateUserSession,
  refreshSessionToken,
  orderAuthTokensByPlatform,
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

async function authenticateRequest(req, res) {
  let tokens = extractAuthTokens(req);
  if (!tokens.length) {
    return { ok: false, status: 401, error: 'Authentication failed. No token provided.' };
  }

  const preferredPlatform = getPreferredAuthPlatform(req);
  if (preferredPlatform) {
    tokens = await orderAuthTokensByPlatform(tokens, preferredPlatform);
  }

  let lastError = null;

  for (const token of tokens) {
    try {
      const decoded = await verifyJwt(token, process.env.JWT_SECRET_KEY);

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
        const { valid, session } = await validateUserSession(user, decoded, token);
        if (!valid) continue;

        req.body.userId = userId;
        req.session = session;
        req.authToken = token;

        const nowInSeconds = Math.floor(Date.now() / 1000);
        const expiresInSeconds = typeof decoded.exp === 'number' ? decoded.exp - nowInSeconds : null;
        const shouldRefreshToken =
          typeof expiresInSeconds === 'number' &&
          expiresInSeconds > 0 &&
          expiresInSeconds <= ONE_DAY_IN_SECONDS;

        if (shouldRefreshToken) {
          const refreshedToken = session
            ? await refreshSessionToken(user, session)
            : user.generateAuthToken();

          if (!session) {
            user.auth_token = refreshedToken;
            await user.save();
          }

          const platform = resolvePlatform(req);
          const clientId = resolveClientId(req, { platform });
          setAuthTokenCookie(res, req, {
            token: refreshedToken,
            platform: session?.platform || platform,
            clientId: session?.clientId || clientId,
            sessionId: session?.sessionId,
            role: 'client',
          });
        }

        return { ok: true };
      }

      if (humanAgent) {
        req.body.userId = humanAgent.userId;
        req.authToken = token;
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

module.exports = async (req, res, next) => {
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
