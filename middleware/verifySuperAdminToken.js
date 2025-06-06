const jwt = require('jsonwebtoken');
const SuperAdmin = require('../models/SuperAdmin');

const verifySuperAdminToken = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    
    // Check if the token is for a superadmin
    // if (decoded.role !== 'superadmin') {
    //   return res.status(403).json({ message: 'Access denied. SuperAdmin privileges required.' });
    // }

    // Verify the superadmin still exists and is active
    const superAdmin = await SuperAdmin.findById(decoded.id);
    if (!superAdmin || !superAdmin.isActive) {
      return res.status(401).json({ message: 'Invalid token or account deactivated.' });
    }

    req.superAdmin = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    };
    
    next();
  } catch (error) {
    console.error('SuperAdmin token verification error:', error);
    res.status(401).json({ message: 'Invalid token.' });
  }
};

module.exports = {
  verifySuperAdminToken
};