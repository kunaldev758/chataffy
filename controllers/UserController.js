require("dotenv").config();
const User = require('../models/User');
const Client = require('../models/Client');
const Widget = require('../models/Widget');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const smtpTransport = require('nodemailer-smtp-transport');
const commonHelper = require("../helpers/commonHelper.js");
const crypto = require('crypto');
const UserController = {};
const https = require('https');

const transporter = nodemailer.createTransport(
  smtpTransport({
    host: 'email-smtp.us-east-1.amazonaws.com', // SMTP server hostname
    port: 587, // Port for the SMTP server (587 for TLS, 465 for SSL)
    secure: false, // Set to true if using SSL
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  })
);

// Construct the path to the email template file
const templateFilePath = path.join(__dirname, '..', '/public/email-templates', 'email-new-account-verification.html');

// Read the HTML email template from the file
const emailTemplate = fs.readFileSync(templateFilePath, 'utf-8');
// Create a new user with email verification
UserController.createUser = async (req, res) => {
  try {
    const { email, password, role } = req.body;
    // Check if the email is already registered
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ status_code: 201, status: false, message: 'Email already in use' });
    }
    const user = new User({ email, password, role });
    const emailVerificationToken = user.generateAuthToken();
    user.verification_token = emailVerificationToken; // Store the token in the user document    
    const userId = user.id;
    await user.save();
    // Generate client specific details
    const client = new Client({userId});
    client.qdrantIndexName = `${userId}`;
    client.qdrantIndexNamePaid = crypto.randomBytes(16).toString('hex');
    client.email = email;
    await client.save();
    // Generate widget token and insert in widget table
    const widgetToken = crypto.randomBytes(8).toString('hex') + userId;
    const widget = new Widget({userId,widgetToken});
    await widget.save();

    const client_url = process.env.CLIENT_URL;
    const verificationLink = `${client_url}verify-email?token=${emailVerificationToken}`;
    const emailContent = emailTemplate.replace(/VERIFY_LINK_HERE/g, verificationLink);
    const mailOptions = {
      from: 'Chataffy <support@favseo.com>',
      to: email,
      subject: 'Email Verification',
      html: emailContent, // Use the modified email content
    };
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).json({ status_code: 201, status: false, message: 'Verification email sending failed', error, info });
      }
      return res.status(200).json({ status_code: 200, status: true, message: 'User registered. Check your email for verification.' });
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ status_code: 500, status: false, message: 'User creation failed' });
  }
};
// Verify email
UserController.verifyEmail = async (req, res) => {
  const { token } = req.body;
  const verification_token = decodeURIComponent(token);
  try {
    const user = await User.findOne({ verification_token });
    if (!user) {
      return res.status(400).json({ status_code: 201, status: false, message: 'Invalid verification token' });
    }
    if (user.email_verified == 1) {
      return res.status(400).json({ status_code: 201, status: false, message: 'Already verify, Please login' });
    }
    user.email_verified = true;
    // user.verification_token = '';
    await user.save();
    return res.status(200).json({ status_code: 200, status: true, message: 'Email verified successfully' });
  } catch (error) {
    return res.status(500).json({ status_code: 500, status: false, message: 'Email verification failed' });
  }
};
// Login user
UserController.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || user.isDeleted || !(await user.comparePassword(password))) {
      return res.status(401).json({ status_code: 201, status: false, message: 'Invalid email or password' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ status_code: 201, status: false, message: 'Please verify your email address' });
    }
    // Generate an authentication token
    const token = user.generateAuthToken();
    user.auth_token = token;
    await user.save();

    if (req.io) {
      req.io.emit('user-logged-in', { userId: user._id });
    }
    
    res.json({ status_code: 200, status: true, token,userId:user?._id, message: 'Login successful' });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ status_code: 500, status: false, message: 'Login failed' });
  }
};
// Delete user (soft delete)
UserController.deleteUser = async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ status_code: 404, status: false, message: 'User not found' });
    }
    const client = await Client.findOne({userId});
    user.isDeleted = true;
    client.isDeleted = true;
    await client.save();
    await user.save();
    res.json({ status_code: 200, status: true, message: 'User deleted successfully' });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ status_code: 500, status: false, message: 'User deletion failed' });
  }
};

// Login user
UserController.logoutUser = async (req, res) => {
  try {
    const userId = req.body.userId;
    const user = await User.findById(userId);
    if (user) {
      //user.status = 'blank';
      user.auth_token = '';
      await user.save();
      res.json({ status_code: 200, status: true, message: 'Logout successful' });
    } else {
      return res.status(403).json({ status_code: 201, status: false, message: 'Invalid data please try agian' });
    }

  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ status_code: 500, status: false, message: 'Logout failed' });
  }
};

UserController.getClient = async (req,res) => {
  try {
    const userId = req.params.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }

    const client = await Client.findOne({ userId: userId });
    if (!client) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Client not found' });
    }

    res.json({ status_code: 200, status: true, client });
  } catch (error) {
    res.status(500).json({ status_code: 500, status: false, message: 'Failed to retrieve client' });
  }
}
// Google OAuth exchange (login/signup)
UserController.googleOAuth = async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Token is required' });
    }

    // Try to resolve Google profile using either id_token (tokeninfo) or access_token (userinfo)
    const profile = await resolveGoogleProfile(token);
    if (!profile || !profile.email) {
      return res.status(401).json({ status_code: 401, status: false, message: 'Invalid Google token' });
    }

    const email = String(profile.email).toLowerCase();
    const googleId = profile.sub || profile.user_id || profile.id;
    if (!googleId) {
      return res.status(401).json({ status_code: 401, status: false, message: 'Unable to extract Google ID' });
    }

    let user = await User.findOne({ email });
    if (user && user.isDeleted) {
      return res.status(403).json({ status_code: 403, status: false, message: 'Account is deactivated' });
    }

    const isNewUser = !user;
    if (!user) {
      user = new User({
        email,
        role: 'client',
        email_verified: true,
        provider: 'google',
        googleId,
        // set a random password to satisfy schema if needed
        password: crypto.randomBytes(16).toString('hex')
      });

      const userId = user.id;
      await user.save();

      // Create related Client and Widget like in createUser
      
      const client = new Client({ userId });
      client.qdrantIndexName = `${userId}`;
      client.qdrantIndexNamePaid = crypto.randomBytes(16).toString('hex');
      client.email = email;
      await client.save();

      const widgetToken = crypto.randomBytes(8).toString('hex') + userId;
      const widget = new Widget({ userId, widgetToken });
      await widget.save();
    } else {
      // Ensure linkage and verification
      if (!user.googleId) user.googleId = googleId;
      user.provider = 'google';
      user.email_verified = true;
      await user.save();
    }

    const appToken = user.generateAuthToken();
    user.auth_token = appToken;
    await user.save();

    if (req.io) {
      req.io.emit('user-logged-in', { userId: user._id });
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      token: appToken,
      role: user.role,
      userId: user?._id,
      isNewUser
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Google OAuth failed' });
  }
};

async function resolveGoogleProfile(token) {
  // If token looks like a JWT, attempt tokeninfo id_token flow
  const isJwt = typeof token === 'string' && token.split('.').length === 3;
  if (isJwt) {
    const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
    const info = await getJson(tokenInfoUrl);
    // info contains email, sub, aud, etc., when valid
    if (info && info.email && info.sub) return info;
  }
  // Fallback to access_token userinfo flow
  const userInfoUrl = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const info = await getJson(userInfoUrl, { Authorization: `Bearer ${token}` });
  return info;
}

function getJson(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const request = https.request(url, { method: 'GET', headers }, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            resolve(json);
          } catch (_e) {
            resolve(null);
          }
        });
      });
      request.on('error', () => resolve(null));
      request.end();
    } catch (_e) {
      resolve(null);
    }
  });
}
module.exports = UserController;