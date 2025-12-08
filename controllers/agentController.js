require("dotenv").config();
const Agent = require("../models/Agent");
const Client = require("../models/Client");
const { sendAgentApprovalEmail } = require("../services/emailService");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const {checkPlanLimits} = require('../services/PlanService');
const path = require('path');
const fs = require('fs');


exports.agentLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const agent = await Agent.findOne({ email });

    if (!agent) {
      return res.status(400).json({ message: "Invalid email or password" });
    }
    if (agent.status !== "approved") {
      return res.status(403).json({ message: "Your invitation is not yet accepted or approved." });
    }

    const isMatch = await bcrypt.compare(password, agent.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Create JWT
    const token = jwt.sign(
      { id: agent._id, email: agent.email, role: "agent" },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "7d" }
    );

    if (agent?.isActive) {
      agent.lastActive = new Date();
      await Agent.updateOne(
        { _id: agent._id },
        { $set: { lastActive: agent.lastActive } }
      );
    }

    res.json({
      message: "Login successful",
      token,
      agent: {
        id: agent._id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        isActive: agent.isActive,
        userId: agent.userId,
        avatar: agent.avatar,
      },
    });
  } catch (error) {
    console.error("Agent login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

async function generateRandomPassword(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// Create a new agent
exports.createAgent = async (req, res) => {
  try {
    const { name, email, userId } = req.body;

    const checkLimit = await checkPlanLimits(userId, 'add_agent');

    if (!checkLimit.canAddAgents) {
      await Client.updateOne({ userId }, { $set: { "upgradePlanStatus.agentLimitExceeded": true } });
      return res.status(403).json({
        message: "Agent limit reached. Please upgrade your plan to add more agents.",
        upgradeSuggested: true
      });
    }

    // Check if agent already exists
    const existingAgent = await Agent.findOne({ email });
    const existingClinet = await Client.findOne({ email });
    if (existingAgent || existingClinet) {
      return res
        .status(400)
        .json({ message: "User with this email already exists" });
    }

    // Generate a random password for the agent
    const password = await generateRandomPassword();
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const inviteToken = crypto.randomBytes(32).toString("hex");
    const inviteTokenExpires = Date.now() + 1000 * 60 * 60 * 24; // 24 hours

    // Create new agent
    const agent = new Agent({
      name,
      email,
      password: hashedPassword,
      inviteToken,
      inviteTokenExpires,
      userId:userId
      // Avatar will be handled on frontend with default-image.png
    });

    await agent.save();

    const acceptUrl = `${process.env.CLIENT_URL}agent-accept-invite/?token=${inviteToken}`;
    await sendAgentApprovalEmail({ ...agent.toObject()}, acceptUrl, password );

    res.status(201).json({
      message: "Agent created successfully",
      agent: {
        id: agent._id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        isActive: agent.isActive,
        inviteToken,
        inviteTokenExpires,
        userId:agent.userId,
        avatar: agent.avatar,
      },
    });
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({ message: "Error creating agent" });
  }
};

// Get all agents
exports.getAllAgents = async (req, res) => {
  try {
    const userId = req.body.userId;
    const agents = await Agent.find({userId:userId, isClient: { $ne: true }}, "-password");
    res.json(agents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ message: "Error fetching agents" });
  }
};

// Get single agent
exports.getAgent = async (req, res) => {
  try {
    const agent = await Agent.findById(req.params.id, "-password");
    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }
    res.json(agent);
  } catch (error) {
    console.error("Error fetching agent:", error);
    res.status(500).json({ message: "Error fetching agent" });
  }
};

// Update agent
exports.updateAgent = async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const agent = await Agent.findById(req.params.id);

    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }

    // If password change is requested
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Current password is required" });
      }
      
      // Verify current password (adjust based on your auth setup)
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, agent.password);
      if (!isCurrentPasswordValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
      
      // Hash and update new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      agent.password = hashedNewPassword;
    }

    // Update other fields
    agent.name = name || agent.name;
    // agent.email = email || agent.email;

    await agent.save();

    res.json({
      message: "Agent updated successfully",
      agent: {
        id: agent._id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        isActive: agent.isActive,
        userId: agent.userId,
        avatar: agent.avatar,
      },
    });
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({ message: "Error updating agent" });
  }
};

// Delete agent
exports.deleteAgent = async (req, res) => {
  try {
    const agent = await Agent.findByIdAndDelete(req.params.id);
    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }
    res.json({ message: "Agent deleted successfully" });
  } catch (error) {
    console.error("Error deleting agent:", error);
    res.status(500).json({ message: "Error deleting agent" });
  }
};

// Approve agent
exports.acceptInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const agent = await Agent.findOne({
      inviteToken: token,
      inviteTokenExpires: { $gt: Date.now() },
    });
    if (!agent) {
      return res
        .status(400)
        .json({ message: "Invalid or expired invitation token" });
    }
    agent.status = "approved";
    agent.inviteToken = undefined;
    agent.inviteTokenExpires = undefined;
    await agent.save();
    res.status(200).json({ message: "Invitation accepted, agent approved!" });
  } catch (error) {
    res.status(500).json({ message: "Error accepting invitation" });
  }
};

// Update agent status (online/offline)
exports.updateAgentStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    const agent = await Agent.findById(req.params.id);

    if (!agent) {
      return res.status(404).json({ message: "Agent not found" });
    }

    agent.isActive = isActive;
    agent.lastActive = isActive ? new Date() : null;
    await agent.save();

    res.json({
      message: "Agent status updated successfully",
      agent: {
        id: agent._id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        isActive: agent.isActive,
        lastActive: agent.lastActive,
        avatar: agent.avatar,
      },
    });
  } catch (error) {
    console.error("Error updating agent status:", error);
    res.status(500).json({ message: "Error updating agent status" });
  }
};

// Upload agent avatar
exports.uploadAgentAvatar = async (req, res) => {
  try {
    const agentId = req.params.id;
    
    if (!agentId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "Agent ID is required" 
      });
    }
    
    if (!req.file) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "No file uploaded" 
      });
    }
    
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png'];
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    
    if (!allowedTypes.includes(req.file.mimetype) || !allowedExtensions.includes(fileExtension)) {
      // Delete uploaded file if validation fails
      if (req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (deleteError) {
          console.error('Error deleting invalid file:', deleteError);
        }
      }
      return res.status(400).json({ 
        status_code: 400, 
        message: "Invalid file type. Only JPG and PNG files are allowed." 
      });
    }
    
    // Check file size (5MB limit)
    if (req.file.size > 5 * 1024 * 1024) {
      // Delete uploaded file if too large
      if (req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (deleteError) {
          console.error('Error deleting file:', deleteError);
        }
      }
      return res.status(400).json({ 
        status_code: 400, 
        message: "File too large. Maximum size is 5MB." 
      });
    }
    
    const agent = await Agent.findById(agentId);
    
    if (!agent) {
      // Delete uploaded file if agent not found
      if (req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (deleteError) {
          console.error('Error deleting file:', deleteError);
        }
      }
      return res.status(404).json({ 
        status_code: 404, 
        message: "Agent not found" 
      });
    }
    
    // Delete old avatar if exists
    if (agent.avatar) {
      const oldAvatarPath = path.join(__dirname, '..', agent.avatar);
      try {
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      } catch (deleteError) {
        console.error('Error deleting old avatar:', deleteError);
      }
    }
    
    const filePath = `/uploads/${req.file.filename}`;
    
    agent.avatar = filePath;
    await agent.save();
    
    res.status(200).json({ 
      status_code: 200,
      message: "Avatar uploaded successfully",
      agent: {
        id: agent._id,
        name: agent.name,
        email: agent.email,
        avatar: agent.avatar,
      }
    });
  } catch (error) {
    console.error("Error uploading avatar:", error);
    res.status(500).json({ 
      status_code: 500, 
      message: "Error uploading avatar" 
    });
  }
};
