require("dotenv").config();
const Agent = require("../models/Agent");
const Client = require("../models/Client");
const HumanAgent = require("../models/HumanAgent");
const { sendAgentApprovalEmail } = require("../services/emailService");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const {checkPlanLimits} = require('../services/PlanService');
const path = require('path');
const fs = require('fs');
const appEvents = require("../events");


exports.agentLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const humanAgent = await HumanAgent.findOne({ email });

    if (!humanAgent) {
      return res.status(400).json({ message: "Invalid email or password" });
    }
    if (humanAgent.status !== "approved") {
      return res.status(403).json({ message: "Your invitation is not yet accepted or approved." });
    }

    const isMatch = await bcrypt.compare(password, humanAgent.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Create JWT
    const token = jwt.sign(
      { id: humanAgent._id, email: humanAgent.email, role: "human-agent" },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "7d" }
    );

    if (humanAgent?.isActive) {
      humanAgent.lastActive = new Date();
      await HumanAgent.updateOne(
        { _id: humanAgent._id },
        { $set: { lastActive: humanAgent.lastActive } }
      );
    }

    res.json({
      message: "Login successful",
      token,
      humanAgent: {
        id: humanAgent._id,
        name: humanAgent.name,
        email: humanAgent.email,
        status: humanAgent.status,
        isActive: humanAgent.isActive,
        userId: humanAgent.userId,
        avatar: humanAgent.avatar,
        assignedAgents: humanAgent.assignedAgents,
      },
    });
  } catch (error) {
    console.error("Human agent login error:", error);
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
exports.createHumanAgent = async (req, res) => {
  try {
    const { name, email, userId, agentId, assignedAgents } = req.body;

    const checkLimit = await checkPlanLimits(userId, 'add_human_agent');

    if (!checkLimit.canAddHumanAgents) {
      await Client.updateOne({ userId }, { $set: { "upgradePlanStatus.humanAgentLimitExceeded": true } });
      return res.status(403).json({
        message: "Human agent limit reached. Please upgrade your plan to add more human agents.",
        upgradeSuggested: true
      });
    }

    // assignedAgents (AI agent/website IDs) - required; human agent can only take chats for these agents
    const agentIds = Array.isArray(assignedAgents) && assignedAgents.length > 0
      ? assignedAgents
      : (agentId ? [agentId] : []);
    if (agentIds.length === 0) {
      return res.status(400).json({ message: "At least one agent (website) must be assigned" });
    }

    // Check if agent already exists
    const existingAgent = await HumanAgent.findOne({ email });
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
    const humanAgent = new HumanAgent({
      userId: userId,
      name: name,
      email: email,
      password: hashedPassword,
      status: 'pending',
      isClient: false,
      avatar: '',
      assignedAgents: agentIds,
      inviteToken: inviteToken,
      inviteTokenExpires: inviteTokenExpires,
    });

    await humanAgent.save();

    const acceptUrl = `${process.env.CLIENT_URL}agent-accept-invite/?token=${inviteToken}`;
    await sendAgentApprovalEmail({ ...humanAgent.toObject() }, acceptUrl, password);

    res.status(201).json({
      message: "Human agent created successfully",
      humanAgent: {
        id: humanAgent._id,
        name: humanAgent.name,
        email: humanAgent.email,
        status: humanAgent.status,
        isActive: humanAgent.isActive,
        inviteToken: inviteToken,
        inviteTokenExpires: inviteTokenExpires,
        userId:humanAgent.userId,
        avatar: humanAgent.avatar,
        assignedAgents: humanAgent.assignedAgents,
      },
    });
  } catch (error) {
    console.error("Error creating human agent:", error);
    res.status(500).json({ message: "Error creating human agent" });
  }
};

// Get all agents
exports.getAllHumanAgents = async (req, res) => {
  try {
    const userId = req.body.userId;
    const humanAgents = await HumanAgent.find({userId:userId}, "-password");
    res.json(humanAgents);
  } catch (error) {
    console.error("Error fetching human agents:", error);
    res.status(500).json({ message: "Error fetching human agents" });
  }
};

// Get single agent
exports.getHumanAgent = async (req, res) => {
  try {
    const humanAgent = await HumanAgent.findById(req.params.id, "-password");
    if (!humanAgent) {
      return res.status(404).json({ message: "Human agent not found" });
    }
    res.json(humanAgent);
  } catch (error) {
    console.error("Error fetching human agent:", error);
    res.status(500).json({ message: "Error fetching human agent" });
  }
};

// Update agent
exports.updateHumanAgent = async (req, res) => {
  try {
    const { name, currentPassword, newPassword , assignedAgents} = req.body;
    const humanAgent = await HumanAgent.findById(req.params.id);

    if (!humanAgent) {
      return res.status(404).json({ message: "Human agent not found" });
    }

    // If password change is requested
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Current password is required" });
      }
      
      // Verify current password (adjust based on your auth setup)
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, humanAgent.password);
      if (!isCurrentPasswordValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
      
      // Hash and update new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      humanAgent.password = hashedNewPassword;
    }

    // Update other fields
    humanAgent.name = name || humanAgent.name;
    humanAgent.assignedAgents = assignedAgents || humanAgent.assignedAgents;
    // agent.email = email || agent.email;

    await humanAgent.save();

    res.json({
      message: "Human agent updated successfully",
      humanAgent: {
        id: humanAgent._id,
        name: humanAgent.name,
        email: humanAgent.email,
        status: humanAgent.status,
        isActive: humanAgent.isActive,
        userId: humanAgent.userId,
        avatar: humanAgent.avatar,
        assignedAgents: humanAgent.assignedAgents,
      },
    });
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({ message: "Error updating agent" });
  }
};

// Delete agent
exports.deleteHumanAgent = async (req, res) => {
  try {
    const humanAgent = await HumanAgent.findByIdAndDelete(req.params.id);
    if (!humanAgent) {
      return res.status(404).json({ message: "Human agent not found" });
    }
    res.json({ message: "Human agent deleted successfully" });
  } catch (error) {
    console.error("Error deleting human agent:", error);
    res.status(500).json({ message: "Error deleting human agent" });
  }
};

// Approve agent
exports.acceptInviteHumanAgent = async (req, res) => {
  try {
    const { token } = req.params;
    console.log(token,"token")
    const humanAgent = await HumanAgent.findOne({
      inviteToken: token,
      inviteTokenExpires: { $gt: Date.now() },
    });
    if (!humanAgent) {
      return res
        .status(400)
        .json({ message: "Invalid or expired invitation token" });
    }
    humanAgent.status = "approved";
    humanAgent.inviteToken = undefined;
    humanAgent.inviteTokenExpires = undefined;
    await humanAgent.save();
    res.status(200).json({ message: "Invitation accepted, human agent approved!" });
  } catch (error) {
    res.status(500).json({ message: "Error accepting invitation for human agent" });
  }
};

// Update agent status (online/offline)
exports.updateHumanAgentStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    const humanAgent = await HumanAgent.findById(req.params.id);

    if (!humanAgent) {
      return res.status(404).json({ message: "Human agent not found" });
    }

    humanAgent.isActive = isActive;
    humanAgent.lastActive = isActive ? new Date() : null;
    await humanAgent.save();

    // Emit socket event to notify all clients about agent status change
    const updatedAgentData = {
      id: humanAgent._id,
      _id: humanAgent._id,
      name: humanAgent.name,
      email: humanAgent.email,
      status: humanAgent.status,
      isActive: humanAgent.isActive,
      lastActive: humanAgent.lastActive,
      avatar: humanAgent.avatar,
      userId: humanAgent.userId,
      assignedAgents: humanAgent.assignedAgents,
      isClient: !!humanAgent.isClient,
    };

    // Emit to the client's room (userId) so settings page can update
    if (humanAgent.userId) {
      appEvents.emit("userEvent", humanAgent.userId.toString(), "human-agent-status-updated", updatedAgentData);
      appEvents.emit("userEvent", humanAgent.userId.toString(), "agent-status-updated", updatedAgentData);
    }

    // Also emit to the agent's own room (humanAgent id) in case they're viewing settings
    appEvents.emit("userEvent", humanAgent._id.toString(), "human-agent-status-updated", updatedAgentData);
    appEvents.emit("userEvent", humanAgent._id.toString(), "agent-status-updated", updatedAgentData);

    // Client agent (isClient): same events as UserController.updateClientStatus for inbox / profile menu
    if (humanAgent.isClient) {
      const clientPayload = {
        _id: humanAgent._id,
        userId: humanAgent.userId,
        email: humanAgent.email,
        name: humanAgent.name,
        isActive: humanAgent.isActive,
        lastActive: humanAgent.lastActive,
        isClient: true,
        assignedAgents: humanAgent.assignedAgents,
      };
      if (humanAgent.userId) {
        appEvents.emit("userEvent", humanAgent.userId.toString(), "client-status-updated", clientPayload);
      }
      appEvents.emit("userEvent", humanAgent._id.toString(), "client-status-updated", clientPayload);
    }

    res.json({
      message: "Human agent status updated successfully",
      humanAgent: updatedAgentData,
    });
  } catch (error) {
    console.error("Error updating human agent status:", error);
    res.status(500).json({ message: "Error updating human agent status" });
  }
};

// Upload agent avatar
exports.uploadHumanAgentAvatar = async (req, res) => {
  try {
    const humanAgentId = req.params.id;
    
    if (!humanAgentId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "Human agent ID is required" 
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
    
    const humanAgent = await HumanAgent.findById(humanAgentId);
    const requestUserId = req.body?.userId;
    if (
      requestUserId &&
      humanAgent &&
      String(humanAgent.userId) !== String(requestUserId)
    ) {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_e) {}
      }
      return res.status(403).json({
        status_code: 403,
        message: "Not allowed to update this profile photo",
      });
    }

    if (!humanAgent) {
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
        message: "Human agent not found" 
      });
    }
    
    // Delete old avatar if exists
    if (humanAgent.avatar) {
      const oldAvatarPath = path.join(__dirname, '..', humanAgent.avatar);
      try {
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      } catch (deleteError) {
        console.error('Error deleting old avatar:', deleteError);
      }
    }
    
    const filePath = `/uploads/${req.file.filename}`;
    
    humanAgent.avatar = filePath;
    await humanAgent.save();
    
    res.status(200).json({ 
      status_code: 200,
      message: "Avatar uploaded successfully",
      agent: {
        id: humanAgent._id,
        name: humanAgent.name,
        email: humanAgent.email,
        avatar: humanAgent.avatar,
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
