require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Client = require("../models/Client");
const Widget = require("../models/Widget");
const Agent = require("../models/Agent.js");
const HumanAgent = require("../models/HumanAgent.js");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const smtpTransport = require("nodemailer-smtp-transport");
const commonHelper = require("../helpers/commonHelper.js");
const PlanService = require("../services/PlanService");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const UserController = {};
const https = require("https");
const { saveChatTranscriptSettings } = require("./ChatTranscriptController.js");
const { getAuthCookieOptions } = require("../helpers/helper.js");
const {
  AGENT_TOKEN,
  CLIENT_TOKEN,
  LEGACY_TOKEN,
  collectAuthTokenCandidates,
  setClientSessionCookies,
  clearClientSessionCookies,
  clearAgentSessionCookies,
} = require("../constants/authCookies");
const UserSession = require("../models/userSession.js");
const ContactUs = require("../models/ContactUs.js");

const transporter = nodemailer.createTransport(
  smtpTransport({
    host: process.env.SMTP_HOST, // SMTP server hostname
    port: process.env.SMTP_PORT, // Port for the SMTP server (587 for TLS, 465 for SSL)
    secure: false, // Set to true if using SSL
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  }),
);

// Construct the path to the email template file
const templateFilePath = path.join(
  __dirname,
  "..",
  "/public/email-templates",
  "email-new-account-verification.html",
);
const forgotPasswordTemplatePath = path.join(
  __dirname,
  "..",
  "/public/email-templates",
  "email-forgot-password.html",
);

// Read the HTML email template from the file
const emailTemplate = fs.readFileSync(templateFilePath, "utf-8");
const forgotPasswordTemplate = fs.readFileSync(
  forgotPasswordTemplatePath,
  "utf-8",
);

/** Issue a fresh 15-minute verification link and email it to the user. */
async function sendVerificationEmail(user) {
  const emailVerificationToken = user.generateEmailVerificationToken();
  user.verification_token = emailVerificationToken;
  await user.save();

  const client_url = process.env.CLIENT_URL;
  const verificationLink = `${client_url}verify-email?token=${emailVerificationToken}`;
  const emailContent = emailTemplate.replace(
    /VERIFY_LINK_HERE/g,
    verificationLink,
  );
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "Email Verification",
    html: emailContent,
  };

  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
// Create a new user with email verification
UserController.createUser = async (req, res) => {
  try {
    const { email, password, role } = req.body;
    // Check if the email is already registered
    const existingUser = await User.findOne({ email });
    // Check if the email is already registered as an agent
    const existingAgentForEmail = await Agent.findOne({ email });
    if (existingAgentForEmail) {
      return res.status(400).json({
        status_code: 201,
        status: false,
        message: "Email already in use",
      });
    }
    if (existingUser) {
      return res.status(400).json({
        status_code: 201,
        status: false,
        message: "Email already in use",
      });
    }
    const user = new User({ email, password, role });
    const userId = user.id;
    await user.save();
    //create agent — set qdrant fields before first save (they are required)
    const agentId = new mongoose.Types.ObjectId();
    const agent = new Agent({
      _id: agentId,
      userId: userId,
      qdrantIndexName: `${userId}-${agentId}`,
      qdrantIndexNamePaid: `${crypto.randomBytes(16).toString("hex")}-${agentId}`,
    });
    await agent.save();
    // Generate client specific details
    const client = new Client({ userId });
    client.email = email;
    await client.save();
    await PlanService.seedCustomLimitsForNewClient(userId);
    // Generate widget token and insert in widget table
    const widgetToken =
      crypto.randomBytes(8).toString("hex") + userId + agent._id;
    const widget = new Widget({ userId, widgetToken, agentId: agent._id });
    await widget.save();

    // Create agent for client
    try {
      // Check if agent already exists with this email (email is unique)
      const existingAgent = await HumanAgent.findOne({ email });
      if (!existingAgent) {
        const humanAgentPassword = crypto.randomBytes(16).toString("hex");
        const hashedPassword = await bcrypt.hash(humanAgentPassword, 10);
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent(agent),
          email: email,
          password: hashedPassword,
          userId: userId,
          status: "approved",
          isClient: true,
          avatar: "",
          assignedAgents: [agent._id], // Default avatar path
        });
        await humanAgent.save();
      }
    } catch (humanAgentError) {
      // Log error but don't fail client creation if agent creation fails
      console.error("Error creating/updating client agent:", humanAgentError);
      console.error("HumanAgent error details:", {
        message: humanAgentError.message,
        code: humanAgentError.code,
        keyPattern: humanAgentError.keyPattern,
        keyValue: humanAgentError.keyValue,
        stack: humanAgentError.stack,
      });
    }

    console.log("Creating Transcript emails for user:", userId);
    const chatTranscript = await saveChatTranscriptSettings(
      userId,
      [email],
      [email],
      [email],
      "",
      "",
    );
    if (chatTranscript instanceof Error) {
      console.error(
        "Error creating chat transcript while creating user:",
        chatTranscript.message,
      );
    } else {
      console.log("Chat transcript created successfully:", chatTranscript);
    }

    try {
      await sendVerificationEmail(user);
      return res.status(200).json({
        status_code: 200,
        status: true,
        message: "User registered. Check your email for verification.",
      });
    } catch (error) {
      return res.status(500).json({
        status_code: 201,
        status: false,
        message: "Verification email sending failed",
        error,
      });
    }
  } catch (error) {
    console.error("Error creating user:", error);
    commonHelper.logErrorToFile(error);
    res.status(500).json({
      status_code: 500,
      status: false,
      message: "User creation failed",
    });
  }
};
// Verify email
UserController.verifyEmail = async (req, res) => {
  const { token } = req.body;
  const verification_token = decodeURIComponent(token);
  try {
    const user = await User.findOne({ verification_token });
    if (!user) {
      return res.status(400).json({
        status_code: 201,
        status: false,
        message: "Invalid verification token",
      });
    }

    // First-time verification: link must be used within 15 minutes (JWT exp). Already-verified users can still use the stored link to sign in.
    if (!user.email_verified) {
      try {
        jwt.verify(verification_token, process.env.JWT_SECRET_KEY);
      } catch (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(400).json({
            status_code: 201,
            status: false,
            message: "Verification link has expired.",
          });
        }
        return res.status(400).json({
          status_code: 201,
          status: false,
          message: "Invalid verification token",
        });
      }
    }

    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    // Already verified: still return a session so reopening the link (e.g. new tab) signs the user in
    if (user.email_verified) {
      const authToken = user.generateAuthToken("local");
      // Create UserSession instead of storing on User
      await UserSession.create({
        userId: user._id,
        platform: "local",
        token: authToken,
        ip:
          req.headers["x-client-ip"] || req.ip ||
          (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
        deviceInfo: req.headers["user-agent"] || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      });
      if (req.io) {
        req.io.emit("user-logged-in", { userId: user._id });
      }
      return res.status(200).json({
        status_code: 200,
        status: true,
        token: authToken,
        userId: user._id,
        isOnboarded: user.getIsOnboarded("local"),
        agents,
        message: "Signed in successfully",
      });
    }

    user.email_verified = true;
    const token = user.generateAuthToken("local");
    // Create UserSession instead of storing on User
    await UserSession.create({
      userId: user._id,
      platform: "local",
      token,
      ip:
        req.headers["x-client-ip"] || req.ip ||
        (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
      deviceInfo: req.headers["user-agent"] || "unknown",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    await user.save();

    if (req.io) {
      req.io.emit("user-logged-in", { userId: user._id });
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      token,
      userId: user._id,
      isOnboarded: user.getIsOnboarded("local"),
      agents,
      message: "Email verified successfully",
    });
  } catch (error) {
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Email verification failed",
    });
  }
};

// Request password reset email
UserController.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !String(email).trim()) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Email is required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const successMessage = "Password Reset Link has been sent.";
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || user.isDeleted) {
      return res
        .status(200)
        .json({ status_code: 200, status: true, message: successMessage });
    }

    const resetToken = user.generatePasswordResetToken();
    user.password_reset_token = resetToken;
    await user.save();

    const client_url = process.env.CLIENT_URL;
    const resetLink = `${client_url}reset-password?token=${encodeURIComponent(resetToken)}`;
    const emailContent = forgotPasswordTemplate.replace(
      /RESET_LINK_HERE/g,
      resetLink,
    );
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: normalizedEmail,
      subject: "Reset Your Password",
      html: emailContent,
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) {
        return res.status(500).json({
          status_code: 500,
          status: false,
          message: "Failed to send password reset email",
        });
      }
      return res
        .status(200)
        .json({ status_code: 200, status: true, message: successMessage });
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to process password reset request",
    });
  }
};

// Reset password using token from email link
UserController.resetPassword = async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;
    if (!token) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Reset token is required",
      });
    }
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "New password and confirmation are required",
      });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Passwords do not match",
      });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message:
          "Password must be at least 8 characters and include uppercase, number, and symbol",
      });
    }

    const resetToken = decodeURIComponent(String(token));
    const user = await User.findOne({ password_reset_token: resetToken });
    if (!user || user.isDeleted) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Invalid or expired reset link",
      });
    }

    try {
      const decoded = jwt.verify(resetToken, process.env.JWT_SECRET_KEY);
      if (decoded.purpose !== "password_reset") {
        return res.status(400).json({
          status_code: 400,
          status: false,
          message: "Invalid reset link",
        });
      }
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        user.password_reset_token = undefined;
        await user.save();
        return res.status(400).json({
          status_code: 400,
          status: false,
          message: "Reset link has expired. Please request a new one.",
        });
      }
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Invalid reset link",
      });
    }

    user.password = newPassword;
    user.password_reset_token = undefined;
    await user.save();

    return res.status(200).json({
      status_code: 200,
      status: true,
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to reset password",
    });
  }
};

// Login user
UserController.loginUser = async (req, res) => {
  try {
    const { email, password, resendVerification } = req.body;
    const user = await User.findOne({ email });
    console.log(user, " <-------- user");
    if (!user || user.isDeleted || !(await user.comparePassword(password))) {
      return res.status(401).json({
        status_code: 201,
        status: false,
        message: "Invalid email or password",
      });
    }
    if (!user.email_verified) {
      if (resendVerification) {
        try {
          await sendVerificationEmail(user);
          return res.status(403).json({
            status_code: 201,
            status: false,
            requires_email_verification: true,
            verification_email_sent: true,
            message: "Verification email sent. Please check your inbox.",
          });
        } catch (error) {
          commonHelper.logErrorToFile(error);
          return res.status(500).json({
            status_code: 201,
            status: false,
            requires_email_verification: true,
            verification_email_sent: false,
            message: "Failed to send verification email.",
          });
        }
      }
      return res.status(403).json({
        status_code: 201,
        status: false,
        requires_email_verification: true,
        verification_email_sent: false,
        message: "Please verify your email address",
      });
    }
    // Generate an authentication token
    const token = user.generateAuthToken("local");
    // Create UserSession instead of storing on User
    await UserSession.create({
      userId: user._id,
      platform: "local",
      token,
      ip:
        req.headers["x-client-ip"] || req.ip ||
        (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
      deviceInfo: req.headers["user-agent"] || "unknown",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // Fetch all AI agents for this user
    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    if (req.io) {
      req.io.emit("user-logged-in", { userId: user._id });
    }

    console.log("check agents data is during login : ", agents);

    // we need to find out the human agent id here ---->

    const humanAgentData = await HumanAgent.findOne({
      userId: user._id,
      isClient: true,
    });

    console.log("humanAgentData : ", humanAgentData);

    setClientSessionCookies(res, req, token);
    res.json({
      status_code: 200,
      status: true,
      token,
      userId: user?._id,
      isOnboarded: user.getIsOnboarded("local"),
      agents,
      humanAgentId: humanAgentData?._id,
      message: "Login successful",
    });
  } catch (error) {
    console.log("Error during login:", error);
    commonHelper.logErrorToFile(error);
    res
      .status(500)
      .json({ status_code: 500, status: false, message: "Login failed" });
  }
};
// Delete user (soft delete)
UserController.deleteUser = async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }
    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }
    const client = await Client.findOne({ userId });
    user.isDeleted = true;
    client.isDeleted = true;
    await client.save();
    await user.save();
    res.json({
      status_code: 200,
      status: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({
      status_code: 500,
      status: false,
      message: "User deletion failed",
    });
  }
};

// Login user
UserController.logoutUser = async (req, res) => {
  try {
    if (req.authSession?.portal === "agent") {
      clearAgentSessionCookies(res, req);
      return res.json({
        status_code: 200,
        status: true,
        message: "Logout successful",
      });
    }

    const userId = req.body.userId;
    const user = await User.findById(userId);
    if (user) {
      // Invalidate all local platform sessions for this user
      await UserSession.findOneAndDelete({
        userId: user._id,
        platform: "local",
        token: req.authSession?.token,
      });
      clearClientSessionCookies(res, req);
      const cookieOptions = getAuthCookieOptions(req);
      res.clearCookie("platform", cookieOptions);
      res.json({
        status_code: 200,
        status: true,
        message: "Logout successful",
      });
    } else {
      return res.status(403).json({
        status_code: 201,
        status: false,
        message: "Invalid data please try agian",
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res
      .status(500)
      .json({ status_code: 500, status: false, message: "Logout failed" });
  }
};

UserController.getClient = async (req, res) => {
  try {
    const userId = req.params.userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }

    const client = await Client.findOne({ userId: userId });
    if (!client) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "Client not found" });
    }

    // Also get the client's agent record (where isClient: true)
    const Agent = require("../models/HumanAgent.js");
    const clientAgent = await Agent.findOne({
      userId: userId,
      isClient: true,
    }).select("-password");

    // Include agent data in response if found
    const response = {
      status_code: 200,
      status: true,
      client: client.toObject ? client.toObject() : client,
    };

    if (clientAgent) {
      response.clientAgent = clientAgent.toObject
        ? clientAgent.toObject()
        : clientAgent;
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to retrieve client",
    });
  }
};

// Update client status (online/offline) - updates the client's agent record
UserController.updateClientStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    const userId = req.body.userId || req.user?.userId; // Get userId from request body or auth middleware

    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }

    // Find the client's agent record (where isClient: true)
    const Agent = require("../models/HumanAgent.js");
    const clientAgent = await Agent.findOne({ userId: userId, isClient: true });

    if (!clientAgent) {
      return res.status(404).json({
        status_code: 404,
        status: false,
        message: "Client agent not found",
      });
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
      appEvents.emit(
        "userEvent",
        clientAgent.userId.toString(),
        "client-status-updated",
        updatedClientData,
      );
      // Also emit agent-status-updated for consistency
      appEvents.emit(
        "userEvent",
        clientAgent.userId.toString(),
        "agent-status-updated",
        updatedClientData,
      );
    }

    // Also emit to the agent's own room (agentId)
    appEvents.emit(
      "userEvent",
      clientAgent._id.toString(),
      "client-status-updated",
      updatedClientData,
    );
    appEvents.emit(
      "userEvent",
      clientAgent._id.toString(),
      "agent-status-updated",
      updatedClientData,
    );

    res.json({
      status_code: 200,
      status: true,
      message: "Client status updated successfully",
      agent: updatedClientData,
    });
  } catch (error) {
    console.error("Error updating client status:", error);
    res.status(500).json({
      status_code: 500,
      status: false,
      message: "Error updating client status",
    });
  }
};
// Google OAuth exchange (login/signup)
UserController.googleOAuth = async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Token is required",
      });
    }

    // Try to resolve Google profile using either id_token (tokeninfo) or access_token (userinfo)
    const profile = await resolveGoogleProfile(token);
    if (!profile || !profile.email) {
      return res.status(401).json({
        status_code: 401,
        status: false,
        message: "Invalid Google token",
      });
    }

    const email = String(profile.email).toLowerCase();
    const googleId = profile.sub || profile.user_id || profile.id;
    if (!googleId) {
      return res.status(401).json({
        status_code: 401,
        status: false,
        message: "Unable to extract Google ID",
      });
    }

    // Check if email already exists in Agent (only block if agent is not a client agent)
    const existingAgent = await Agent.findOne({ email });
    if (existingAgent && !existingAgent.isClient) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Email already in use",
      });
    }

    // Check if user already exists for login flow
    let user = await User.findOne({ email });
    let isNewUser = false;

    if (user) {
      // User exists - LOGIN flow
      if (user.isDeleted) {
        return res.status(403).json({
          status_code: 403,
          status: false,
          message: "Account is deactivated",
        });
      }

      // Update user with Google info if not already set
      if (!user.googleId) user.googleId = googleId;
      if (!user.provider || user.provider !== "google")
        user.provider = "google";
      user.email_verified = true;
      await user.save();

      isNewUser = false;
    } else {
      // User doesn't exist - SIGNUP flow
      user = new User({
        email,
        role: "client",
        email_verified: true,
        provider: "google",
        googleId,
        // set a random password to satisfy schema if needed
        password: crypto.randomBytes(16).toString("hex"),
      });

      const userId = user.id;
      await user.save();
      const agentId = new mongoose.Types.ObjectId();
      const agent = new Agent({
        _id: agentId,
        userId: userId,
        qdrantIndexName: `${userId}-${agentId}`,
        qdrantIndexNamePaid: `${crypto.randomBytes(16).toString("hex")}-${agentId}`,
      });
      await agent.save();

      // Create related Client and Widget like in createUser
      const client = new Client({ userId });

      client.email = email;
      await client.save();
      await PlanService.seedCustomLimitsForNewClient(userId);

      const widgetToken =
        crypto.randomBytes(8).toString("hex") + userId + agent._id;
      const widget = new Widget({ userId, widgetToken, agentId: agent._id });
      await widget.save();

      // Create agent for client
      try {
        const agentPassword = crypto.randomBytes(16).toString("hex");
        const hashedPassword = await bcrypt.hash(agentPassword, 10);
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent(agent),
          email: email,
          password: hashedPassword,
          userId: userId,
          status: "approved",
          isClient: true,
          avatar: "", // Default avatar path
          assignedAgents: [agent._id], // Default avatar path
        });
        await humanAgent.save();
      } catch (humanAgentError) {
        // Log error but don't fail client creation if agent creation fails
        console.error("Error creating client agent:", humanAgentError);
        console.error("Agent error details:", {
          message: agentError.message,
          code: agentError.code,
          keyPattern: agentError.keyPattern,
          keyValue: agentError.keyValue,
          stack: agentError.stack,
        });
      }

      console.log("Creating Transcript emails for user:", userId);
      const chatTranscript = await saveChatTranscriptSettings(
        userId,
        [email],
        [email],
        [email],
        "",
        "",
      );
      if (chatTranscript instanceof Error) {
        console.error(
          "Error creating chat transcript while creating user:",
          chatTranscript.message,
        );
      } else {
        console.log("Chat transcript created successfully:", chatTranscript);
      }

      isNewUser = true;
    }

    // Generate token for both login and signup
    const appToken = user.generateAuthToken("local");
    // Create UserSession instead of storing on User
    await UserSession.create({
      userId: user._id,
      platform: "local",
      token: appToken,
      ip:
        req.headers["x-client-ip"] || req.ip ||
        (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
      deviceInfo: req.headers["user-agent"] || "unknown",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // Fetch all AI agents for this user
    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    if (req.io) {
      req.io.emit("user-logged-in", { userId: user._id });
    }

    // we need to find out the human agent id here ---->

    const humanAgentData = await HumanAgent.findOne({
      userId: user._id,
      isClient: true,
    });

    console.log("humanAgentData : ", humanAgentData);

    setClientSessionCookies(res, req, appToken);

    return res.status(200).json({
      status_code: 200,
      status: true,
      token: appToken,
      role: user.role,
      userId: user?._id,
      isOnboarded: user.getIsOnboarded("local"),
      humanAgentId: humanAgentData?._id,
      agents,
      isNewUser,
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Google OAuth failed",
    });
  }
};

async function resolveGoogleProfile(token) {
  // If token looks like a JWT, attempt tokeninfo id_token flow
  const isJwt = typeof token === "string" && token.split(".").length === 3;
  if (isJwt) {
    const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
    const info = await getJson(tokenInfoUrl);
    // info contains email, sub, aud, etc., when valid
    if (info && info.email && info.sub) return info;
  }
  // Fallback to access_token userinfo flow
  const userInfoUrl = "https://www.googleapis.com/oauth2/v3/userinfo";
  const info = await getJson(userInfoUrl, { Authorization: `Bearer ${token}` });
  return info;
}

function getJson(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const request = https.request(
        url,
        { method: "GET", headers },
        (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              const json = JSON.parse(data || "{}");
              resolve(json);
            } catch (_e) {
              resolve(null);
            }
          });
        },
      );
      request.on("error", () => resolve(null));
      request.end();
    } catch (_e) {
      resolve(null);
    }
  });
}

function isStrongPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return false;
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
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }
    const user = await User.findById(userId).select(
      "-password -verification_token -auth_token",
    );
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }
    const clientAgent = await HumanAgent.findOne({
      userId,
      isClient: true,
    }).select("-password");
    if (!clientAgent) {
      return res.status(404).json({
        status_code: 404,
        status: false,
        message: "Client profile not found",
      });
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
        phone: user.phone || "",
        provider: user.provider || "local",
      },
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to load profile",
    });
  }
};

/** Name on HumanAgent (isClient); email + phone on User (sync HumanAgent + Client email) */
UserController.updateClientProfileGeneral = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { name, email, phone } = req.body;
    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }
    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }
    const clientAgent = await HumanAgent.findOne({ userId, isClient: true });
    if (!clientAgent) {
      return res.status(404).json({
        status_code: 404,
        status: false,
        message: "Client profile not found",
      });
    }

    if (typeof name === "string" && name.trim()) {
      clientAgent.name = name.trim();
    }

    if (phone !== undefined) {
      const p =
        phone === null || phone === "" ? undefined : String(phone).trim();
      user.phone = p;
    }

    if (email !== undefined && String(email).trim()) {
      const normalized = String(email).toLowerCase().trim();
      const emailTaken = await User.findOne({
        email: normalized,
        _id: { $ne: userId },
      });
      if (emailTaken) {
        return res.status(400).json({
          status_code: 400,
          status: false,
          message: "Email is already in use",
        });
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
      phone: user.phone || "",
    };
    if (clientAgent.userId) {
      appEvents.emit(
        "userEvent",
        clientAgent.userId.toString(),
        "client-profile-updated",
        profileSocketPayload,
      );
    }
    appEvents.emit(
      "userEvent",
      clientAgent._id.toString(),
      "client-profile-updated",
      profileSocketPayload,
    );

    return res.json({
      status_code: 200,
      status: true,
      message: "Profile updated",
      clientAgent: {
        _id: clientAgent._id,
        name: clientAgent.name,
        avatar: clientAgent.avatar,
        email: clientAgent.email,
      },
      user: {
        email: user.email,
        phone: user.phone || "",
      },
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to update profile",
    });
  }
};

/** Password change on User only */
UserController.updateClientPassword = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { currentPassword, newPassword } = req.body;
    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Current and new password are required",
      });
    }
    if (
      newPassword !== req.body.confirmPassword &&
      req.body.confirmPassword !== undefined
    ) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "New passwords do not match",
      });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message:
          "Password must be at least 8 characters and include uppercase, number, and symbol",
      });
    }
    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }
    const ok = await user.comparePassword(currentPassword);
    if (!ok) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Current password is incorrect",
      });
    }
    user.password = newPassword;
    await user.save();
    return res.json({
      status_code: 200,
      status: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to update password",
    });
  }
};

UserController.getClientByToken = async (req, res) => {
  console.log("inside get client by token", req.params);
  try {
    const rawToken = req.params?.token;
    if (!rawToken) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Token is required",
      });
    }

    const token = decodeURIComponent(String(rawToken));

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);

      console.log("decoded data is :", decoded);
    } catch (err) {
      if (err?.name === "TokenExpiredError") {
        return res
          .status(401)
          .json({ status_code: 401, status: false, message: "Token expired" });
      }
      return res
        .status(401)
        .json({ status_code: 401, status: false, message: "Invalid token" });
    }

    // Don't allow URL-based login with impersonation tokens.
    // if (decoded?.purpose === "impersonation") {
    //   return res.status(403).json({ status_code: 403, status: false, message: "Forbidden token type" });
    // }

    const userId = decoded?._id;
    if (!userId) {
      return res.status(401).json({
        status_code: 401,
        status: false,
        message: "Invalid token payload",
      });
    }

    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }

    // Create a fresh app session token (so the caller doesn't need to keep using URL tokens).
    const appToken = user.generateAuthToken("local");
    // Create UserSession instead of storing on User
    await UserSession.create({
      userId: user._id,
      platform: "local",
      token: appToken,
      ip:
        req.headers["x-client-ip"] || req.ip ||
        (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
      deviceInfo: req.headers["user-agent"] || "unknown",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    if (req.io) {
      req.io.emit("user-logged-in", { userId: user._id });
    }

    // find out the human Agent Id --->

    // here we fetch the Human Agent and then return it ---->
    const humanAgentData = await HumanAgent.findOne({
      userId: user._id,
      isClient: true,
    })
      .select("_id")
      .lean();
    // create human agent in case if it is not present --->

    let humanAgent = null;
    if (!humanAgentData) {
      // create a new Human Agent for the client if not exists
      try {
        const agentId =
          agents.length > 0 ? agents[0]._id : new mongoose.Types.ObjectId();
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent({ _id: agentId }),
          email: user.email,
          password: crypto.randomBytes(16).toString("hex"), // Random password since client won't use it
          userId: user._id,
          status: "approved",
          isClient: true,
          avatar: "", // Default avatar path
          assignedAgents: agents.map((a) => a._id), // Assign all existing agents to this human agent
        });
        await humanAgent.save();
      } catch (error) {
        console.error("Error creating human agent:", error);
      }
    }

    console.log("humanAgentData : ", humanAgentData);

    return res.status(200).json({
      status_code: 200,
      status: true,
      token: appToken,
      userId: user._id,
      isOnboarded: user.getIsOnboarded("local"),
      agents,
      humanAgentId: humanAgentData?._id ? humanAgentData._id : humanAgent?._id,
      message: "Signed in successfully",
    });

    
  } catch (error) {
    console.error("Error getting client by token:", error);
    res.status(500).json({ message: "Error getting client by token" });
  }
};

// platform redirection login
UserController.platformRedirectionLogin = async (req, res) => {
  try {
    const { userId, shortLivedtoken } = req.params;
    // console.log("userId is :", userId);
    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!shortLivedtoken) {
      return res.status(400).json({ message: "Short Lived Token is required" });
    }

    const decodedToken = jwt.verify(
      shortLivedtoken,
      process.env.JWT_SECRET_KEY,
    );
    if (!decodedToken) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    if (req.io) {
      req.io.emit("user-logged-in", {
        userId: user._id,
      });
    }

    const appToken = user.generateAuthToken("local");
    // Create a new UserSession so multiple concurrent logins can coexist
    let session = await UserSession.findOne({
      userId: user._id,
      platform: "local",
    }).lean();
    if (!session) {
      session = await UserSession.create({
        userId: user._id,
        platform: "local",
        token: appToken,
        ip:
          req.headers["x-client-ip"] || req.ip ||
          (req.headers["x-forwarded-for"] || "").split(",").pop().trim(),
        deviceInfo: req.headers["user-agent"] || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      });
    }

    // here we fetch the Human Agent and then return it ---->
    const humanAgentData = await HumanAgent.findOne({
      userId: user._id,
      isClient: true,
    })
      .select("_id")
      .lean();

    // create human agent in case if it is not present --->

    let humanAgent = null;
    if (!humanAgentData) {
      // create a new Human Agent for the client if not exists
      try {
        const agentId =
          agents.length > 0 ? agents[0]._id : new mongoose.Types.ObjectId();
        const humanAgent = new HumanAgent({
          name: commonHelper.clientHumanAgentNameFromAgent({ _id: agentId }),
          email: user.email,
          password: crypto.randomBytes(16).toString("hex"), // Random password since client won't use it
          userId: user._id,
          status: "approved",
          isClient: true,
          avatar: "", // Default avatar path
          assignedAgents: agents.map((a) => a._id), // Assign all existing agents to this human agent
        });
        await humanAgent.save();
      } catch (error) {
        console.error("Error creating human agent:", error);
      }
    }

    console.log("humanAgentData : ", humanAgentData);
    setClientSessionCookies(res, req, session.token);

    return res.status(200).json({
      status_code: 200,
      status: true,
      token: session.token,
      userId: user._id,
      isOnboarded: user.getIsOnboarded("local"),
      agents,
      humanAgentId: humanAgentData?._id ? humanAgentData._id : humanAgent?._id,
      message: "Login successful",
    });
  } catch (error) {
    console.error("Error in platform redirection login:", error);
    res.status(500).json({ message: "Error in platform redirection login" });
  }
};

UserController.setWebAuthCookies = async (req, res) => {
  try {
    const cookieOptions = getAuthCookieOptions(req);
    res.cookie("platform", "local", cookieOptions);
    return res.status(200).json({
      status_code: 200,
      status: true,
      message: "Web auth cookies set successfully",
    });
  } catch (error) {
    console.error("Error in set web auth cookies:", error);
    res.status(500).json({ message: "Error in set web auth cookies" });
  }
};

UserController.validateToken = async (req, res) => {
  try {
    const expectedPortal = String(
      req.query?.portal || req.body?.portal || "",
    ).toLowerCase();
    const getCandidatePriority = (name, index) => {
      if (expectedPortal === "agent") {
        if (name === AGENT_TOKEN) return 0;
        if (name === "authorization") return 1;
        if (name === LEGACY_TOKEN) return 2;
        return 99;
      }

      if (expectedPortal === "client") {
        if (name === "authorization") return 0;
        if (name === CLIENT_TOKEN) return 1;
        if (name === "sf_token" || name === "bc_token") return 2;
        if (name === LEGACY_TOKEN) return 3;
        return 99;
      }

      return index;
    };

    const candidates = collectAuthTokenCandidates(req)
      .map((candidate, index) => {
        return {
          ...candidate,
          index,
          priority: getCandidatePriority(candidate.name, index),
        };
      })
      .filter((candidate) => candidate.priority < 99)
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    if (!candidates.length) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Token is required",
      });
    }

    let decoded;
    let token;
    let tokenExpired = false;
    for (const candidate of candidates) {
      try {
        const candidateDecoded = jwt.verify(
          candidate.token,
          process.env.JWT_SECRET_KEY,
        );
        const role = candidateDecoded?.role;
        const isHumanAgentToken =
          role === "human-agent" || (role === "agent" && candidateDecoded?.id);
        const portal = isHumanAgentToken ? "agent" : "client";

        if (expectedPortal && portal !== expectedPortal) {
          continue;
        }

        decoded = candidateDecoded;
        token = candidate.token;
        break;
      } catch (err) {
        if (err?.name === "TokenExpiredError") {
          tokenExpired = true;
        }
      }
    }

    if (!decoded || !token) {
      if (tokenExpired) {
        return res
          .status(401)
          .json({ status_code: 401, status: false, message: "Token expired" });
      }

      return res.status(401).json({
        status_code: 401,
        status: false,
        message: expectedPortal
          ? "Token does not match requested portal"
          : "Invalid token",
      });
    }

    const userId = decoded?._id;
    const role = decoded?.role;
    const isHumanAgentToken =
      role === "human-agent" || (role === "agent" && decoded?.id);

    if (isHumanAgentToken) {
      const humanAgent = await HumanAgent.findOne({ _id: decoded.id });
      if (!humanAgent) {
        return res.status(404).json({
          status_code: 404,
          status: false,
          message: "Agent not found",
        });
      }

      const currentAgentId = humanAgent.assignedAgents?.[0] || "";
      const agent = {
        id: humanAgent._id,
        _id: humanAgent._id,
        name: humanAgent.name,
        email: humanAgent.email,
        status: humanAgent.status,
        isActive: humanAgent.isActive,
        userId: humanAgent.userId,
        avatar: humanAgent.avatar,
        assignedAgents: humanAgent.assignedAgents,
      };

      return res.json({
        status_code: 200,
        status: true,
        valid: true,
        role: "agent",
        message: "Login successful",
        token,
        userId: humanAgent.userId,
        humanAgentId: humanAgent._id,
        currentAgentId,
        agent,
        humanAgent: agent,
      });
    }

    if (!userId) {
      return res.status(401).json({
        status_code: 401,
        status: false,
        message: "Invalid token payload",
      });
    }

    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }

    // Fetch all AI agents for this user
    const agents = await Agent.find({
      userId: user._id,
      isDeleted: false,
    }).select("_id agentName isActive");

    const humanAgentData = await HumanAgent.findOne({
      userId: user._id,
      isClient: true,
    });

    return res.json({
      status_code: 200,
      status: true,
      valid: true,
      role: "client",
      token,
      userId: user?._id,
      currentAgentId: agents?.[0]?._id || "",
      isOnboarded: user.isOnboarded,
      agents,
      humanAgentId: humanAgentData?._id,
      message: "Login successful",
    });
  } catch (error) {
    console.log("Error in validate token:", error);
    res.status(500).json({ message: "Error in validate token" });
  }
};

UserController.generateShortLivedToken = async (req, res) => {
  try {
    const { userId, platform } = req.body;
    if (!userId) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "User ID is required",
      });
    }
    if (!platform) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Platform is required",
      });
    }
    const user = await User.findById(userId).lean();
    if (!user || user.isDeleted) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "User not found" });
    }

    const token = jwt.sign(
      { _id: user._id, role: user.role, platform: platform },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "2m" },
    );

    return res.json({
      status_code: 200,
      status: true,
      token,
      message: "Short-lived token generated successfully",
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to generate short-lived token",
    });
  }
};

UserController.contactUs = async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    const message =
      typeof req.body.message === "string" ? req.body.message.trim() : "";
    const phone =
      typeof req.body.phone === "string" ? req.body.phone.trim() : "";
    const service = req.body.services || "";
    const website = req.body.website || "";
    console.log("req.body is :", req.body);

    if (!name || !email || !message || !service) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Name, email, and message are required",
      });
    }

    if (name.length > 100) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Name must be at most 100 characters",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Please provide a valid email address",
      });
    }

    if (message.length < 10) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Message must be at least 10 characters",
      });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        status_code: 400,
        status: false,
        message: "Message must be at most 1000 characters",
      });
    }

    if (phone) {
      const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
      if (!phoneRegex.test(phone.replace(/[\s\-\(\)]/g, ""))) {
        return res.status(400).json({
          status_code: 400,
          status: false,
          message: "Please provide a valid phone number",
        });
      }
    }

    await ContactUs.create({
      name,
      email,
      phone: phone || "",
      message,
      service,
      website,
    });

    const supportEmail = process.env.SUPPORT_EMAIL;
    const appName = process.env.APP_NAME || "Chataffy";
    if (supportEmail) {
      try {
        const mailOptions = {
          from: `${appName} <${process.env.SMTP_FROM}>`,
          replyTo: email,
          to: "mohammadasjad.deskmoz@gmail.com",
          subject: "Contact Us",
          text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone || "N/A"}\nMessage: ${message}`,
        };
        await transporter.sendMail(mailOptions);
      } catch (mailError) {
        console.log("Error in sending contact us email:", mailError);
        commonHelper.logErrorToFile(mailError);
      }
    }
    console.log("Contact us email sent successfully");
    return res.status(200).json({
      status_code: 200,
      status: true,
      message: "Your message has been submitted successfully",
    });
  } catch (error) {
    console.log("Error in contact us:", error);
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status_code: 500,
      status: false,
      message: "Failed to contact us",
    });
  }
};

module.exports = UserController;
