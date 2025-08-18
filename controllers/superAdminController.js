const SuperAdmin = require("../models/SuperAdmin");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
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

    // 2. Total Agents
    const totalAgents = await Agent.countDocuments();

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

    // 5. AI vs Human Chat Ratio
    const totalConversations = await Conversation.countDocuments();
    const aiChats = await Conversation.countDocuments({ aiChat: true });
    const humanChats = totalConversations - aiChats;
    
    const aiChatPercentage = totalConversations > 0 ? ((aiChats / totalConversations) * 100).toFixed(2) : 0;
    const humanChatPercentage = totalConversations > 0 ? ((humanChats / totalConversations) * 100).toFixed(2) : 0;

    // 7. Additional metrics
    const approvedAgents = await Agent.countDocuments({ status: "approved" });
    const activeAgents = await Agent.countDocuments({ isActive: true });

    // 8. Message statistics
    const totalMessages = await ChatMessage.countDocuments();
    const botMessages = await ChatMessage.countDocuments({ sender_type: "bot" });
    const agentMessages = await ChatMessage.countDocuments({ sender_type: "agent" });
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
        totalAgents,
        activeVisitors,
        totalConversations
      },
      chats: {
        today: chatsToday,
        weekly: chatsWeekly,
        monthly: chatsMonthly
      },
      chatRatio: {
        ai: {
          count: aiChats,
          percentage: parseFloat(aiChatPercentage)
        },
        human: {
          count: humanChats,
          percentage: parseFloat(humanChatPercentage)
        }
      },
      agents: {
        total: totalAgents,
        approved: approvedAgents,
        active: activeAgents
      },
      messages: {
        total: totalMessages,
        bot: botMessages,
        agent: agentMessages,
        visitor: visitorMessages
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

      // Fetch total agents
      const totalAgents = await Agent.find({ userId: client.userId }).countDocuments();

      // Fetch total conversations
      const totalConversations = await Conversation.find({ userId: client.userId }).countDocuments();

      const currentDataUsed = client.currentDataSize;

      // Add usageDetails to client
      client.usageDetails = {
        maxAgents: planDetails.limits.maxAgentsPerAccount,
        totalAgents,
        maxStorage: planDetails.limits.maxStorage,
        currentDataUsed,
        maxQueries: planDetails.limits.maxQueries,
        totalConversations
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

module.exports.getAgent = async (req,res) => {
  try{
    const { clientId } = req.params;
    const client = await Client.findById(clientId);
            if (!client) {
              return res.status(404).json({ message: "Client not found" });
            }
    const agents = await Agent.find({ userId: client.userId })
      .select('-password')
      .sort({ createdAt: -1 });

      res.status(200).json({
        success: true,
        data: {
          agents
        }
      });
  }catch(err){
    console.error("Error fetching agent:", error);
    res.status(500).json({ message: "Error fetching agent" });
  }
}


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
