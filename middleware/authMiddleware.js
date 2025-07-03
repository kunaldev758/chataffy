const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Agent = require('../models/Agent');
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
        cosole.log("Here is bug")
      }
      else{
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
      }
    }
    const userId = decoded._id;
    const user = await User.findById(userId);
    const agentId = decoded.id;
    const agent = await Agent.findById(agentId);
    console.log("testing here", user);
    if(user && user.auth_token == token)
    {
      req.body.userId = userId;
      console.log(userId,req.body);
    }
    else if(agent)
    {
      req.body.userId = agent.userId;
      console.log(userId,req.body);
    }
    else {
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
    }
    next();
  });
  } catch (error) {
    return res.status(401).json({ status_code: 401, error: 'Authentication failed. Invalid token.' });
  }
};
