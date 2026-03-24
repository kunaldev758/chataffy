const SuperAdmin = require("../models/SuperAdmin");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const HumanAgent = require("../models/HumanAgent");
const Conversation = require("../models/Conversation");
const ChatMessage = require("../models/ChatMessage");
const PlanService = require("../services/PlanService")
const UsageTrackingService= require("../services/UsageTrackingService")
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// SuperAdmin login
module.exports.superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const superAdmin = await SuperAdmin.findOne({ email });

    if (!superAdmin) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    if (!superAdmin.isActive) {
      return res.status(403).json({ message: "Account is disabled" });
    }

    const isMatch = await bcrypt.compare(password, superAdmin.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Update last login
    superAdmin.lastLogin = new Date();
    await superAdmin.save();

    // Create JWT
    const token = jwt.sign(
      { id: superAdmin._id, email: superAdmin.email, role: "superadmin" },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      superAdmin: {
        id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        role: superAdmin.role,
        isActive: superAdmin.isActive,
        lastLogin: superAdmin.lastLogin,
      },
    });
  } catch (error) {
    console.error("SuperAdmin login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Create SuperAdmin (for initial setup)
module.exports.createSuperAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Check if superadmin already exists
    const existingSuperAdmin = await SuperAdmin.findOne({ email });
    if (existingSuperAdmin) {
      return res.status(400).json({ message: "SuperAdmin with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new superadmin
    const superAdmin = new SuperAdmin({
      name,
      email,
      password: hashedPassword,
    });

    await superAdmin.save();

    res.status(201).json({
      message: "SuperAdmin created successfully",
      superAdmin: {
        id: superAdmin._id,
        name: superAdmin.name,
        email: superAdmin.email,
        role: superAdmin.role,
        isActive: superAdmin.isActive,
      },
    });
  } catch (error) {
    console.error("Error creating superadmin:", error);
    res.status(500).json({ message: "Error creating superadmin" });
  }
};

// Dashboard data
module.exports.getDashboardData = async (req, res) => {
  try {
    // Get current date ranges
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // 1. Total Clients
    const totalClients = await Client.countDocuments();

    // 2. AI chatbots (Agent) vs human team (HumanAgent)
    const totalAiAgents = await Agent.countDocuments({ isDeleted: { $ne: true } });
    const totalHumanAgents = await HumanAgent.countDocuments();

    // 3. Total Active Visitors (open conversations)
    const activeVisitors = await Conversation.countDocuments({
      conversationOpenStatus: "open"
    });

    // 4. Number of Chats (Today/Weekly/Monthly)
    const chatsToday = await Conversation.countDocuments({
      createdAt: { $gte: startOfToday }
    });

    const chatsWeekly = await Conversation.countDocuments({
      createdAt: { $gte: startOfWeek }
    });

    const chatsMonthly = await Conversation.countDocuments({
      createdAt: { $gte: startOfMonth }
    });

    // 5. AI vs human-handled chats (humanAgentId = assigned human team member)
    const totalConversations = await Conversation.countDocuments();
    const humanHandledChats = await Conversation.countDocuments({
      humanAgentId: { $exists: true, $ne: null },
    });
    const aiOnlyChats = totalConversations - humanHandledChats;

    const aiChatPercentage =
      totalConversations > 0 ? ((aiOnlyChats / totalConversations) * 100).toFixed(2) : 0;
    const humanChatPercentage =
      totalConversations > 0 ? ((humanHandledChats / totalConversations) * 100).toFixed(2) : 0;

    // 7. Human team + AI chatbot activity
    const approvedHumanAgents = await HumanAgent.countDocuments({ status: "approved" });
    const activeHumanAgents = await HumanAgent.countDocuments({ isActive: true });
    const activeAiAgents = await Agent.countDocuments({ isActive: true, isDeleted: { $ne: true } });

    // 8. Message statistics (align with ChatMessage schema: ai / humanAgent / visitor; legacy bot/agent)
    const totalMessages = await ChatMessage.countDocuments();
    const aiMessages = await ChatMessage.countDocuments({
      sender_type: { $in: ["ai", "bot"] },
    });
    const humanAgentMessages = await ChatMessage.countDocuments({
      $or: [
        { humanAgentId: { $exists: true, $ne: null } },
        { sender_type: { $in: ["humanAgent", "client", "agent"] } },
      ],
    });
    const visitorMessages = await ChatMessage.countDocuments({ sender_type: "visitor" });

    // 9. Recent chat activity (last 7 days)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);

      const dayChats = await Conversation.countDocuments({
        createdAt: { $gte: startOfDay, $lt: endOfDay }
      });

      last7Days.push({
        date: startOfDay.toISOString().split('T')[0],
        chats: dayChats
      });
    }

    // 10. OpenAI Usage (all users)
    const openAIUsageAgg = await UsageTrackingService.getOpenAIUsage(undefined);
    const openAIUsage = openAIUsageAgg ? openAIUsageAgg : {
      totalTokens: 0,
      totalCost: 0,
      totalRequests:0
    };

    // 11. Qdrant Usage (all collections)
    const qdrantUsageAgg = await UsageTrackingService.getQdrantUsage(undefined);
    const qdrantUsage = qdrantUsageAgg ? qdrantUsageAgg : {
      totalVectorsAdded: 0,
      totalVectorsDeleted: 0,
      totalEstimatedCostRequests:0,
      totalEstimatedCostStorage:0,
    };

    // 12. Total Revenue (sum of all clients' amount)
    const revenueAgg = await Client.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmountPaid" }
        }
      }
    ]);
    const totalRevenue = revenueAgg && revenueAgg.length > 0 ? revenueAgg[0].totalRevenue : 0;

    const dashboardData = {
      overview: {
        totalClients,
        totalAiAgents,
        totalHumanAgents,
        activeVisitors,
        totalConversations,
      },
      chats: {
        today: chatsToday,
        weekly: chatsWeekly,
        monthly: chatsMonthly
      },
      chatRatio: {
        ai: {
          count: aiOnlyChats,
          percentage: parseFloat(aiChatPercentage),
        },
        human: {
          count: humanHandledChats,
          percentage: parseFloat(humanChatPercentage),
        },
      },
      agents: {
        ai: {
          total: totalAiAgents,
          active: activeAiAgents,
        },
        human: {
          total: totalHumanAgents,
          approved: approvedHumanAgents,
          active: activeHumanAgents,
        },
      },
      messages: {
        total: totalMessages,
        ai: aiMessages,
        humanAgent: humanAgentMessages,
        visitor: visitorMessages,
      },
      chartData: {
        last7Days
      },
      openAIUsage: {
        totalTokens: openAIUsage.totalTokens || 0,
        totalCost: openAIUsage.totalCost || 0
      },
      qdrantUsage: {
        totalVectorsAdded: qdrantUsage.totalVectorsAdded || 0,
        totalVectorsDeleted: qdrantUsage.totalVectorsDeleted || 0,
        totalStorageMB: qdrantUsage.totalStorageMB || 0
      },
      totalRevenue
    };

    res.status(200).json({
      success: true,
      data: dashboardData
    });

  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ message: "Error fetching dashboard data" });
  }
};

// Get all clients with details and metrics (aggregation version)
module.exports.getAllClients = async (req, res) => {
  try {
    const clients = await Client.find({ isDeleted: false }).lean(); // Use lean() to get plain JavaScript objects

    const updatedClients = await Promise.all(clients.map(async (client) => {
      const planDetails = await PlanService.getUserPlan(client.userId);

      if (!planDetails) {
        return client; // Return client as is if no plan details
      }

      const totalAiAgents = await Agent.countDocuments({
        userId: client.userId,
        isDeleted: { $ne: true },
      });
      const totalHumanAgents = await HumanAgent.countDocuments({ userId: client.userId });

      const totalConversations = await Conversation.countDocuments({ userId: client.userId });

      const currentDataUsed = client.currentDataSize;

      client.usageDetails = {
        maxAgents: planDetails.limits.maxAgentsPerAccount,
        totalAgents: totalAiAgents,
        totalAiAgents,
        totalHumanAgents,
        maxStorage: planDetails.limits.maxStorage,
        currentDataUsed,
        maxQueries: planDetails.limits.maxQueries,
        totalConversations,
      };

      return client;
    }));

    res.status(200).json({
      success: true,
      data: updatedClients,
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ message: 'Error fetching clients' });
  }
};

/** AI chatbots (Agent) + human team (HumanAgent) for a client account */
module.exports.getClientAgents = async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const [aiAgents, humanAgents] = await Promise.all([
      Agent.find({ userId: client.userId, isDeleted: { $ne: true } })
        .select(
          "agentName website_name email phone isActive liveAgentSupport lastTrained createdAt qdrantIndexName"
        )
        .sort({ createdAt: -1 })
        .lean(),
      HumanAgent.find({ userId: client.userId })
        .select("-password")
        .populate("assignedAgents", "agentName website_name _id")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        aiAgents,
        humanAgents,
      },
    });
  } catch (error) {
    console.error("Error fetching client agents:", error);
    res.status(500).json({ message: "Error fetching client agents" });
  }
};


module.exports.cancelClientSubscription = async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findById(clientId);

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Set the client's plan to the default plan
    client.plan = "free";
    client.planStatus = "inactive";
    client.paymentStatus = "unpaid";
    client.planExpiry = null;

    await client.save();

    res.status(200).json({
      success: true,
      message: "Client subscription cancelled and set to default plan"
    });
  } catch (error) {
    console.error("Error cancelling client subscription:", error);
    res.status(500).json({ message: "Error cancelling client subscription" });
  }
};
