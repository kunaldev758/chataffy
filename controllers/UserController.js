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
    client.pineconeIndexName = `pinecone-${userId}`;
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
    user.verification_token = '';
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
    if (!user || !(await user.comparePassword(password))) {
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
module.exports = UserController;