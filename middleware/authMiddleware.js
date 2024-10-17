const jwt = require('jsonwebtoken');
const User = require('../models/User');
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
      return res.status(401).json({ status_code: 401, error: 'Authentication failed. User not found.' });
    }
    const userId = decoded._id;
    const user = await User.findById(userId);
    console.log("testing here", user);
    if(user && user.auth_token == token)
    {
      req.body.userId = userId;
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
