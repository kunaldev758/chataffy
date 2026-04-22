require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const Widget = require('../models/Widget');
const User = require('../models/User');
const HumanAgent = require('../models/HumanAgent');
const TrainingListFreeUsers = require('../models/TrainingListFreeUsers');
const Url = require('../models/Url');
const WebsiteData = require('../models/WebsiteData');
const Client = require('../models/Client');
const PlanService = require('../services/PlanService');
const commonHelper = require('../helpers/commonHelper');

const AIAgentController = {};

// GET /ai-agents — return all AI agents for the authenticated user
AIAgentController.getAgents = async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }

    const agents = await Agent.find({ userId, isDeleted: false }).select('_id website_name agentName isActive lastTrained dataTrainingStatus pagesAdded filesAdded faqsAdded currentDataSize');

    // Fetch widget isActive for each agent
    const agentIds = agents.map(a => a._id);
    const widgets = await Widget.find({ agentId: { $in: agentIds } }).select('agentId isActive');
    const widgetMap = {};
    widgets.forEach(w => { widgetMap[w.agentId.toString()] = w.isActive; });

    const agentsWithWidget = agents.map(a => ({
      ...a.toObject(),
      widgetIsActive: widgetMap[a._id.toString()] ?? 1,
    }));

    return res.status(200).json({ status_code: 200, status: true, agents: agentsWithWidget });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to retrieve agents' });
  }
};

// POST /ai-agents — create a new AI agent for the authenticated user
AIAgentController.createAgent = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { agentName } = req.body;

    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }

    const effectiveLimits = await PlanService.getEffectiveLimits(userId);
    const maxAgentsPerAccount = Number(effectiveLimits?.maxAgentsPerAccount);
    if (Number.isFinite(maxAgentsPerAccount) && maxAgentsPerAccount > 0) {
      const agentsCount = await Agent.countDocuments({ userId });
      if (agentsCount >= maxAgentsPerAccount) {
        await Client.updateOne(
          { userId },
          { $set: { 'upgradePlanStatus.agentLimitExceeded': true } }
        );
        return res.status(400).json({
          status_code: 400,
          status: false,
          message: 'Max Website per account limit exceeded',
        });
      }
    }

    const agentId = new mongoose.Types.ObjectId();
    const agent = new Agent({
      _id: agentId,
      userId,
      agentName: agentName || '',
      qdrantIndexName: `${userId}-${agentId}`,
      qdrantIndexNamePaid: `${crypto.randomBytes(16).toString('hex')}-${agentId}`,
    });
    await agent.save();

    // Create a widget for this new agent
    const widgetToken = crypto.randomBytes(8).toString('hex') + userId + agent._id;
    const widget = new Widget({ userId, widgetToken, agentId: agent._id });
    await widget.save();

    const user = await User.findById(userId).select('isOnboarded');
    if (user && !user.isOnboarded) {
      const humanAgent = await HumanAgent.findOne({ userId, isClient: true });
      if (humanAgent) {
        humanAgent.name = commonHelper.clientHumanAgentNameFromAgent(agent);
        await humanAgent.save();
      }
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      message: 'Agent created successfully',
      agent: {
        _id: agent._id,
        agentName: agent.agentName,
        isActive: agent.isActive,
      }
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to create agent' });
  }
};

// GET /agent-settings/:agentId — return agent profile settings
AIAgentController.getAgentSettings = async (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!agentId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Agent ID is required' });
    }
    const agent = await Agent.findById(agentId).select('agentName email phone fallbackMessage liveAgentSupport website_name onboardingStep onboardingWebsiteUrl onboardingExtractedUrls');
    if (!agent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Agent not found' });
    }
    return res.status(200).json({
      status_code: 200,
      status: true,
      data: {
        agentName:                agent.agentName || agent.website_name || '',
        email:                    agent.email || '',
        phone:                    agent.phone || '',
        fallbackMessage:          agent.fallbackMessage || '',
        liveAgentSupport:         agent.liveAgentSupport ?? false,
        onboardingStep:           agent.onboardingStep || 'source',
        onboardingWebsiteUrl:     agent.onboardingWebsiteUrl || '',
        onboardingExtractedUrls:  agent.onboardingExtractedUrls || [],
      }
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to retrieve agent settings' });
  }
};

// POST /updateAgentSettings — update agent profile settings
AIAgentController.updateAgentSettings = async (req, res) => {
  try {
    const { agentId, agentName, email, phone, fallbackMessage, liveAgentSupport, onboardingStep, onboardingWebsiteUrl, onboardingExtractedUrls } = req.body;
    if (!agentId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Agent ID is required' });
    }
    const updateData = {};
    if (agentName                !== undefined) updateData.agentName               = agentName;
    if (email                    !== undefined) updateData.email                   = email;
    if (phone                    !== undefined) updateData.phone                   = phone;
    if (fallbackMessage          !== undefined) updateData.fallbackMessage         = fallbackMessage;
    if (liveAgentSupport         !== undefined) updateData.liveAgentSupport        = liveAgentSupport;
    if (onboardingStep           !== undefined) updateData.onboardingStep          = onboardingStep;
    if (onboardingWebsiteUrl     !== undefined) updateData.onboardingWebsiteUrl    = onboardingWebsiteUrl;
    if (onboardingExtractedUrls  !== undefined) updateData.onboardingExtractedUrls = onboardingExtractedUrls;

    const agent = await Agent.findByIdAndUpdate(agentId, { $set: updateData }, { new: true });
    if (!agent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Agent not found' });
    }

    const owner = await User.findById(agent.userId).select('isOnboarded');
    if (owner && !owner.isOnboarded) {
      const humanAgent = await HumanAgent.findOne({ userId: agent.userId, isClient: true });
      if (humanAgent) {
        humanAgent.name = commonHelper.clientHumanAgentNameFromAgent(agent);
        await humanAgent.save();
      }
    }

    return res.status(200).json({
      status_code: 200,
      status: true,
      message: 'Agent settings updated successfully',
      data: {
        agentName:        agent.agentName,
        email:            agent.email,
        phone:            agent.phone,
        fallbackMessage:  agent.fallbackMessage,
        liveAgentSupport: agent.liveAgentSupport,
      }
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to update agent settings' });
  }
};

// POST /ai-agents/delete/:agentId — hard-delete an AI agent and all related data
AIAgentController.deleteAgent = async (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!agentId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'Agent ID is required' });
    }

    const agent = await Agent.findById(agentId);
    if (!agent) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Agent not found' });
    }

    // Hard delete from all related collections in parallel
    await Promise.all([
      Agent.findByIdAndDelete(agentId),
      Widget.deleteMany({ agentId }),
      TrainingListFreeUsers.deleteMany({ agentId }),
      Url.deleteMany({ agentId }),
      WebsiteData.deleteMany({ agentId }),
      // Drop this website from human agents’ assignedAgents (prevents stale IDs after delete)
      HumanAgent.updateMany(
        { assignedAgents: agentId },
        { $pull: { assignedAgents: new mongoose.Types.ObjectId(agentId) } }
      ),
    ]);

    return res.status(200).json({ status_code: 200, status: true, message: 'Agent deleted successfully' });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to delete agent' });
  }
};

// POST /complete-onboarding — mark the user as onboarded
AIAgentController.completeOnboarding = async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'User ID is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ status_code: 404, status: false, message: 'User not found' });
    }

    user.isOnboarded = true;
    await user.save();

    return res.status(200).json({ status_code: 200, status: true, message: 'Onboarding completed' });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to complete onboarding' });
  }
};

// GET /agent-data/:agentId — return agent data
AIAgentController.getAgentData = async (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!agentId) {
      return res
        .status(400)
        .json({
          status_code: 400,
          status: false,
          message: "Agent ID is required",
        });
    }
    const agent = await Agent.findById(agentId).select(
      "agentName website_name email phone fallbackMessage liveAgentSupport onboardingStep onboardingWebsiteUrl onboardingExtractedUrls isSitemapAdded filesAdded faqsAdded pagesAdded dataTrainingStatus scrapingStartTime",
    );
    if (!agent) {
      return res
        .status(404)
        .json({ status_code: 404, status: false, message: "Agent not found" });
    }

    return res
      .status(200)
      .json({ status_code: 200, status: true, agent: agent });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res
      .status(500)
      .json({
        status_code: 500,
        status: false,
        message: "Failed to get agent data",
      });
  }
};

module.exports = AIAgentController;
