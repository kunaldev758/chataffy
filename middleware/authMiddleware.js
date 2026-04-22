const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Agent = require('../models/Agent');
const HumanAgent = require('../models/HumanAgent');

const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
const SEVEN_DAYS_IN_MS = 7 * 24 * 60 * 60 * 1000;
module.exports = async (req, res, next) => {
  // Get the token from the request headers
  const token = req.header('Authorization');
  // Check if a token was provided
  if (!token) {
    return res.status(401).json({ status_code: 401, error: 'Authentication failed. No token provided.' });
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, decoded) => {
    if (err || !decoded._id) {
      if(decoded?.id){
        console.log("Here is bug")
      }
      else{
      console.log("JWT not verified");
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
      }
    }
    const userId = decoded._id;
    const user = await User.findById(userId);
    if(user?.isDeleted){
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
    }
    // const agentId = decoded.id;
    // const agent = await Agent.findById(agentId);
    const humanAgent = await HumanAgent.findById(decoded.id);
    // console.log("testing here", user);
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
        res.cookie('token', refreshedToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: SEVEN_DAYS_IN_MS,
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
