require("dotenv").config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Client = require('../models/Client');
const Widget = require('../models/Widget');
const Agent = require('../models/Agent.js');
const HumanAgent = require('../models/HumanAgent.js');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const smtpTransport = require('nodemailer-smtp-transport');
const commonHelper = require("../helpers/commonHelper.js");
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const UserController = {};
const https = require('https');
const { saveChatTranscriptSettings } = require("./ChatTranscriptController.js");

const transporter = nodemailer.createTransport(
  smtpTransport({
    host: process.env.SMTP_HOST, // SMTP server hostname
    port: process.env.SMTP_PORT, // Port for the SMTP server (587 for TLS, 465 for SSL)
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
    // Check if the email is already registered as an agent
    const existingAgentForEmail = await Agent.findOne({ email });
    if (existingAgentForEmail) {
      return res.status(400).json({ status_code: 201, status: false, message: 'Email already in use' });
    }
    if (existingUser) {
      return res.status(400).json({ status_code: 201, status: false, message: 'Email already in use' });
    }
    const user = new User({ email, password, role });
    const emailVerificationToken = user.generateEmailVerificationToken();
    user.verification_token = emailVerificationToken; // Store the token in the user document (expires in 15m)
    const userId = user.id;
    await user.save();
    //create agent — set qdrant fields before first save (they are required)
    const agentId = new mongoose.Types.ObjectId();
    const agent = new Agent({
      _id: agentId,
      userId: userId,
      qdrantIndexName: `${userId}-${agentId}`,
      qdrantIndexNamePaid: `${crypto.randomBytes(16).toString('hex')}-${agentId}`,
    });
    await agent.save();
    // Generate client specific details
    const client = new Client({userId});
    client.email = email;
    await client.save();
    // Generate widget token and insert in widget table
    const widgetToken = crypto.randomBytes(8).toString('hex') + userId + agent._id;
    const widget = new Widget({userId,widgetToken,agentId:agent._id});
    await widget.save();

    // Create agent for client
    try {
      // Check if agent already exists with this email (email is unique)
      const existingAgent = await HumanAgent.findOne({ email });
      if (!existingAgent) {
        const humanAgentPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(humanAgentPassword, 10);
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent(agent),
          email: email,
          password: hashedPassword,
          userId: userId,
          status: 'approved',
          isClient: true,
          avatar: '',
          assignedAgents: [agent._id] // Default avatar path
        });
        await humanAgent.save();
      } 
    } catch (humanAgentError) {
      // Log error but don't fail client creation if agent creation fails
      console.error('Error creating/updating client agent:', humanAgentError);
      console.error('HumanAgent error details:', {
        message: humanAgentError.message,
        code: humanAgentError.code,
        keyPattern: humanAgentError.keyPattern,
        keyValue: humanAgentError.keyValue,
        stack: humanAgentError.stack
      });
    }

    console.log("Creating Transcript emails for user:", userId);
    const chatTranscript = await saveChatTranscriptSettings(
      userId,
      [email],
      [email],
      [email],
      '',
      '',
    )
    if (chatTranscript instanceof Error) {
      console.error("Error creating chat transcript while creating user:", chatTranscript.message);
    }else{
      console.log("Chat transcript created successfully:", chatTranscript);
    }

    const client_url = process.env.CLIENT_URL;
    const verificationLink = `${client_url}verify-email?token=${emailVerificationToken}`;
    const emailContent = emailTemplate.replace(/VERIFY_LINK_HERE/g, verificationLink);
    const mailOptions = {
      from: process.env.SMTP_FROM,
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
    console.error("Error creating user:", error);
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

    // First-time verification: link must be used within 15 minutes (JWT exp). Already-verified users can still use the stored link to sign in.
    if (!user.email_verified) {
      try {
        jwt.verify(verification_token, process.env.JWT_SECRET_KEY);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(400).json({
            status_code: 201,
            status: false,
            message: 'Verification link has expired.',
          });
        }
        return res.status(400).json({ status_code: 201, status: false, message: 'Invalid verification token' });
      }
    }

    const agents = await Agent.find({ userId: user._id, isDeleted: false }).select('_id agentName isActive');

    // Already verified: still return a session so reopening the link (e.g. new tab) signs the user in
    if (user.email_verified) {
      const authToken = user.generateAuthToken();
      user.auth_token = authToken;
      await user.save();
      if (req.io) {
        req.io.emit('user-logged-in', { userId: user._id });
      }
      return res.status(200).json({
        status_code: 200,
        status: true,
        token: authToken,
        userId: user._id,
        isOnboarded: user.isOnboarded,
        agents,
        message: 'Signed in successfully',
      });
    }

    user.email_verified = true;
    const token = user.generateAuthToken();
    user.auth_token = token;
    await user.save();

    if (req.io) {
      req.io.emit('user-logged-in', { userId: user._id });
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      token,
      userId: user._id,
      isOnboarded: user.isOnboarded,
      agents,
      message: 'Email verified successfully',
    });
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

    // Fetch all AI agents for this user
    const agents = await Agent.find({ userId: user._id, isDeleted: false }).select('_id agentName isActive');

    if (req.io) {
      req.io.emit('user-logged-in', { userId: user._id });
    }
    
    res.json({
      status_code: 200,
      status: true,
      token,
      userId: user?._id,
      isOnboarded: user.isOnboarded,
      agents,
      message: 'Login successful'
    });
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

    // Also get the client's agent record (where isClient: true)
    const Agent = require('../models/HumanAgent.js');
    const clientAgent = await Agent.findOne({ userId: userId, isClient: true }).select('-password');
    
    // Include agent data in response if found
    const response = {
      status_code: 200,
      status: true,
      client: client.toObject ? client.toObject() : client
    };
    
    if (clientAgent) {
      response.clientAgent = clientAgent.toObject ? clientAgent.toObject() : clientAgent;
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ status_code: 500, status: false, message: 'Failed to retrieve client' });
  }
}

// Update client status (online/offline) - updates the client's agent record
UserController.updateClientStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    const userId = req.body.userId || req.user?.userId; // Get userId from request body or auth middleware
    
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }

    // Find the client's agent record (where isClient: true)
    const Agent = require('../models/HumanAgent.js');
    const clientAgent = await Agent.findOne({ userId: userId, isClient: true });

    if (!clientAgent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Client agent not found' });
    }

    clientAgent.isActive = isActive;
    clientAgent.lastActive = isActive ? new Date() : null;
    await clientAgent.save();

    // Emit socket event to notify about client status change
    const appEvents = require("../events");
    const updatedClientData = {
      id: clientAgent._id,
      _id: clientAgent._id,
      userId: clientAgent.userId,
      email: clientAgent.email,
      name: clientAgent.name,
      isActive: clientAgent.isActive,
      lastActive: clientAgent.lastActive,
      isClient: true,
      assignedAgents: clientAgent.assignedAgents,
    };

    // Emit to the client's room (userId) so inbox can update
    if (clientAgent.userId) {
      appEvents.emit("userEvent", clientAgent.userId.toString(), "client-status-updated", updatedClientData);
      // Also emit agent-status-updated for consistency
      appEvents.emit("userEvent", clientAgent.userId.toString(), "agent-status-updated", updatedClientData);
    }

    // Also emit to the agent's own room (agentId)
    appEvents.emit("userEvent", clientAgent._id.toString(), "client-status-updated", updatedClientData);
    appEvents.emit("userEvent", clientAgent._id.toString(), "agent-status-updated", updatedClientData);

    res.json({
      status_code: 200,
      status: true,
      message: "Client status updated successfully",
      agent: updatedClientData,
    });
  } catch (error) {
    console.error("Error updating client status:", error);
    res.status(500).json({ status_code: 500, status: false, message: "Error updating client status" });
  }
};
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

    // Check if email already exists in Agent (only block if agent is not a client agent)
    const existingAgent = await Agent.findOne({ email });
    if (existingAgent && !existingAgent.isClient) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Email already in use' });
    }

    // Check if user already exists for login flow
    let user = await User.findOne({ email });
    let isNewUser = false;

    if (user) {
      // User exists - LOGIN flow
      if (user.isDeleted) {
        return res.status(403).json({ status_code: 403, status: false, message: 'Account is deactivated' });
      }

      // Update user with Google info if not already set
      if (!user.googleId) user.googleId = googleId;
      if (!user.provider || user.provider !== 'google') user.provider = 'google';
      user.email_verified = true;
      await user.save();

      isNewUser = false;
    } else {
      // User doesn't exist - SIGNUP flow
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
      const agentId = new mongoose.Types.ObjectId();
      const agent = new Agent({
        _id: agentId,
        userId: userId,
        qdrantIndexName: `${userId}-${agentId}`,
        qdrantIndexNamePaid: `${crypto.randomBytes(16).toString('hex')}-${agentId}`,
      });
      await agent.save();

      // Create related Client and Widget like in createUser
      const client = new Client({ userId });
      
      client.email = email;
      await client.save();

      const widgetToken = crypto.randomBytes(8).toString('hex') + userId + agent._id;
      const widget = new Widget({ userId, widgetToken, agentId: agent._id });
      await widget.save();

      // Create agent for client
      try {
        const agentPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(agentPassword, 10);
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent(agent),
          email: email,
          password: hashedPassword,
          userId: userId,
          status: 'approved',
          isClient: true,
          avatar: '', // Default avatar path
          assignedAgents: [agent._id] // Default avatar path
        });
        await humanAgent.save();
      } catch (humanAgentError) {
        // Log error but don't fail client creation if agent creation fails
        console.error('Error creating client agent:', humanAgentError);
        console.error('Agent error details:', {
          message: agentError.message,
          code: agentError.code,
          keyPattern: agentError.keyPattern,
          keyValue: agentError.keyValue,
          stack: agentError.stack
        });
      }

      console.log("Creating Transcript emails for user:", userId);
      const chatTranscript = await saveChatTranscriptSettings(
        userId,
        [email],
        [email],
        [email],
        '',
        '',
      )
      if (chatTranscript instanceof Error) {
        console.error("Error creating chat transcript while creating user:", chatTranscript.message);
      }else{
        console.log("Chat transcript created successfully:", chatTranscript);
      }

      isNewUser = true;
    }

    // Generate token for both login and signup
    const appToken = user.generateAuthToken();
    user.auth_token = appToken;
    await user.save();

    // Fetch all AI agents for this user
    const agents = await Agent.find({ userId: user._id, isDeleted: false }).select('_id agentName isActive');

    if (req.io) {
      req.io.emit('user-logged-in', { userId: user._id });
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      token: appToken,
      role: user.role,
      userId: user?._id,
      isOnboarded: user.isOnboarded,
      agents,
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

function isStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}

/** Dashboard client profile: HumanAgent (isClient) display + User account fields */
UserController.getClientProfile = async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }
    const user = await User.findById(userId).select('-password -verification_token -auth_token');
    if (!user || user.isDeleted) {
      return res.status(404).json({ status_code: 404, status: false, message: 'User not found' });
    }
    const clientAgent = await HumanAgent.findOne({ userId, isClient: true }).select('-password');
    if (!clientAgent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Client profile not found' });
    }
    return res.json({
      status_code: 200,
      status: true,
      clientAgent: {
        _id: clientAgent._id,
        name: clientAgent.name,
        avatar: clientAgent.avatar,
        email: clientAgent.email,
      },
      user: {
        email: user.email,
        phone: user.phone || '',
        provider: user.provider || 'local',
      },
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to load profile' });
  }
};

/** Name on HumanAgent (isClient); email + phone on User (sync HumanAgent + Client email) */
UserController.updateClientProfileGeneral = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { name, email, phone } = req.body;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }
    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res.status(404).json({ status_code: 404, status: false, message: 'User not found' });
    }
    const clientAgent = await HumanAgent.findOne({ userId, isClient: true });
    if (!clientAgent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Client profile not found' });
    }

    if (typeof name === 'string' && name.trim()) {
      clientAgent.name = name.trim();
    }

    if (phone !== undefined) {
      const p = phone === null || phone === '' ? undefined : String(phone).trim();
      user.phone = p;
    }

    if (email !== undefined && String(email).trim()) {
      const normalized = String(email).toLowerCase().trim();
      const emailTaken = await User.findOne({ email: normalized, _id: { $ne: userId } });
      if (emailTaken) {
        return res.status(400).json({ status_code: 400, status: false, message: 'Email is already in use' });
      }
      user.email = normalized;
      clientAgent.email = normalized;
      await Client.updateOne({ userId }, { $set: { email: normalized } });
    }

    await user.save();
    await clientAgent.save();

    const appEvents = require("../events");
    const profileSocketPayload = {
      _id: clientAgent._id,
      userId: clientAgent.userId,
      name: clientAgent.name,
      email: clientAgent.email,
      avatar: clientAgent.avatar,
      isClient: true,
      phone: user.phone || '',
    };
    if (clientAgent.userId) {
      appEvents.emit("userEvent", clientAgent.userId.toString(), "client-profile-updated", profileSocketPayload);
    }
    appEvents.emit("userEvent", clientAgent._id.toString(), "client-profile-updated", profileSocketPayload);

    return res.json({
      status_code: 200,
      status: true,
      message: 'Profile updated',
      clientAgent: {
        _id: clientAgent._id,
        name: clientAgent.name,
        avatar: clientAgent.avatar,
        email: clientAgent.email,
      },
      user: {
        email: user.email,
        phone: user.phone || '',
      },
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to update profile' });
  }
};

/** Password change on User only */
UserController.updateClientPassword = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { currentPassword, newPassword } = req.body;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Current and new password are required' });
    }
    if (newPassword !== req.body.confirmPassword && req.body.confirmPassword !== undefined) {
      return res.status(400).json({ status_code: 400, status: false, message: 'New passwords do not match' });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: 'Password must be at least 8 characters and include uppercase, number, and symbol',
      });
    }
    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res.status(404).json({ status_code: 404, status: false, message: 'User not found' });
    }
    const ok = await user.comparePassword(currentPassword);
    if (!ok) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Current password is incorrect' });
    }
    user.password = newPassword;
    await user.save();
    return res.json({ status_code: 200, status: true, message: 'Password updated successfully' });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to update password' });
  }
};

module.exports = UserController;