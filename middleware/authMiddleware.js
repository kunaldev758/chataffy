const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Agent = require('../models/Agent');
const HumanAgent = require('../models/HumanAgent');
const ImpersonationSession = require('../models/ImpersonationSession');
const {
  extractAuthToken,
  setAuthTokenCookie,
  resolvePlatform,
  resolveClientId,
} = require('../constants/clientCookie.js');

const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

module.exports = async (req, res, next) => {
  const token = extractAuthToken(req);

  if (!token) {
    return res.status(401).json({ status_code: 401, error: 'Authentication failed. No token provided.' });
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, decoded) => {
    if (err || (!decoded?._id && !decoded?.id)) {
      if(decoded?.id){
        console.log("Here is bug")
      }
      else{
      console.log("JWT not verified");
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
      }
    }
    if (decoded?.purpose === 'impersonation') {
      if (!decoded?._id || !decoded?.jti) {
        return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
      }
      const session = await ImpersonationSession.findOne({ jti: decoded.jti });
      if (!session || session.revokedAt) {
        return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
      }
      if (String(session.userId) !== String(decoded._id)) {
        return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
      }
      if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
        return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
      }

      req.body.userId = decoded._id;
      req.body.impersonatedBy = session.superAdminId;
      req.body.isImpersonating = true;
      return next();
    }

    const userId = decoded._id;
    const user = userId ? await User.findById(userId) : null;
    if(user?.isDeleted){
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
    }
    const humanAgent = decoded?.id ? await HumanAgent.findById(decoded.id) : null;
    if(user && user.auth_token == token)
    {
      req.body.userId = userId;
      console.log(userId,req.body);
    }
    else if(humanAgent)
    {
      req.body.userId = humanAgent.userId;
      console.log(userId,req.body);
    }
    else {
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    const expiresInSeconds = typeof decoded.exp === 'number' ? decoded.exp - nowInSeconds : null;
    const shouldRefreshToken =
      typeof expiresInSeconds === 'number' &&
      expiresInSeconds > 0 &&
      expiresInSeconds <= ONE_DAY_IN_SECONDS;

    if (shouldRefreshToken) {
      let refreshedToken = null;

      if (user) {
        refreshedToken = user.generateAuthToken();
        user.auth_token = refreshedToken;
        await user.save();
      } else if (humanAgent) {
        refreshedToken = jwt.sign(
          { id: humanAgent._id, email: humanAgent.email, role: 'human-agent' },
          process.env.JWT_SECRET_KEY,
          { expiresIn: '7d' }
        );
      } 

      if (refreshedToken) {
        console.log("refreshing Token");
        const platform = resolvePlatform(req);
        const clientId = resolveClientId(req, { platform });
        setAuthTokenCookie(res, req, {
          token: refreshedToken,
          platform,
          clientId,
          role: humanAgent ? 'agent' : 'client',
        });
      }
    }
    next();
  });
  } catch (error) {
    console.log("auth middleware error ----> ", error);
    return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
  }
};
