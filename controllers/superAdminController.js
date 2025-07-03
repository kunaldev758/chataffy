const SuperAdmin = require("../models/SuperAdmin");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const Conversation = require("../models/Conversation");
const ChatMessage = require("../models/ChatMessage");
const TrainingList = require("../models/OpenaiTrainingList");
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
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
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

    // 6. AI Fallback Rate (conversations that started with AI but switched to human)
    const aiToHumanSwitched = await Conversation.countDocuments({
      aiChat: false, // Currently disabled (switched to human)
      agentId: { $exists: true } // Has an agent assigned
    });

    const aiFallbackRate = aiChats > 0 ? ((aiToHumanSwitched / aiChats) * 100).toFixed(2) : 0;

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
      aiInsights: {
        fallbackRate: parseFloat(aiFallbackRate),
        totalAiChats: aiChats,
        switchedToHuman: aiToHumanSwitched
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
      }
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
    const clients = await Client.aggregate([
      // Join User
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'userDetails',
        },
      },
      { $unwind: { path: '$userDetails', preserveNullAndEmptyArrays: true } },
      // Count agents for each client
      {
        $lookup: {
          from: 'agents',
          let: { userId: '$userId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$userId', '$$userId'] } } },
            { $count: 'count' },
          ],
          as: 'agentCountArr',
        },
      },
      // Count total conversations for each client
      {
        $lookup: {
          from: 'conversations',
          let: { userId: '$userId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$userId', '$$userId'] } } },
            { $count: 'count' },
          ],
          as: 'totalConversationsArr',
        },
      },
      // Count active (open) conversations for each client
      {
        $lookup: {
          from: 'conversations',
          let: { userId: '$userId' },
          pipeline: [
            { $match: { $expr: { $and: [ { $eq: ['$userId', '$$userId'] }, { $eq: ['$conversationOpenStatus', 'open'] } ] } } },
            { $count: 'count' },
          ],
          as: 'activeConversationsArr',
        },
      },
      // Format output
      {
        $project: {
          _id: 1,
          credits: 1,
          sitemapScrappingStatus: 1,
          webPageScrappingStatus: 1,
          webPageMappingCount: 1,
          webPageAdded: 1,
          faqAdded: 1,
          docSnippetAdded: 1,
          pineconeIndexName: 1,
          createdAt: 1,
          updatedAt: 1,
          details: {
            email: '$userDetails.email',
            name: '$userDetails.email', // Use email as name
            _id: '$userDetails._id',
          },
          metrics: {
            agentCount: { $ifNull: [ { $arrayElemAt: ['$agentCountArr.count', 0] }, 0 ] },
            totalConversations: { $ifNull: [ { $arrayElemAt: ['$totalConversationsArr.count', 0] }, 0 ] },
            activeConversations: { $ifNull: [ { $arrayElemAt: ['$activeConversationsArr.count', 0] }, 0 ] },
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    res.status(200).json({
      success: true,
      data: clients,
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ message: 'Error fetching clients' });
  }
};

// Get all agents across all clients
module.exports.getAllAgentsForSuperAdmin = async (req, res) => {
  try {
    const agents = await Agent.find()
      .populate('userId', 'name email')
      .select('-password')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: agents
    });
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ message: "Error fetching agents" });
  }
};

// Get all conversations with details
module.exports.getAllConversations = async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    
    let filter = {};
    if (status && status !== 'all') {
      filter.conversationOpenStatus = status;
    }

    const conversations = await Conversation.find(filter)
      .populate('userId', 'name email')
      .populate('agentId', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Conversation.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: {
        conversations,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        total
      }
    });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ message: "Error fetching conversations" });
  }
};


// Get detailed client information
exports.getClientDetails = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Get client basic info
    const client = await Client.findById(clientId)
      .populate('userId', 'name email createdAt');
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Get agents for this client
    const agents = await Agent.find({ userId: client.userId })
      .select('-password')
      .sort({ createdAt: -1 });

    // Get conversation metrics
    const conversationStats = await Conversation.aggregate([
      { $match: { userId: client.userId?._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          open: {
            $sum: { $cond: [{ $eq: ["$conversationOpenStatus", "open"] }, 1, 0] }
          },
          closed: {
            $sum: { $cond: [{ $eq: ["$conversationOpenStatus", "close"] }, 1, 0] }
          },
          aiChats: {
            $sum: { $cond: [{ $eq: ["$aiChat", true] }, 1, 0] }
          },
          humanChats: {
            $sum: { $cond: [{ $eq: ["$aiChat", false] }, 1, 0] }
          }
        }
      }
    ]);

    // Get active conversations with details
    const activeConversations = await Conversation.find({
      userId: client.userId?._id,
      conversationOpenStatus: "open"
    }).populate('agentId', 'name email').sort({ updatedAt: -1 }).limit(10);

    // Get message statistics
    const messageStats = await ChatMessage.aggregate([
      { $match: { userId: client.userId?._id } },
      {
        $group: {
          _id: "$sender_type",
          count: { $sum: 1 }
        }
      }
    ]);

    // Get training content size
    const contentSize = await TrainingList.aggregate([
      { $match: { userId: client.userId?._id } },
      {
        $group: {
          _id: null,
          totalSizeInBytes: { $sum: { $bsonSize: "$$ROOT" } }
        }
      }
    ]);

    // Get training content details
    const trainingContent = await TrainingList.find({
      userId: client.userId._id,
      isActive: { $in: [1, 2] }
    }).select('title type lastEdit trainingStatus webPage.url file.fileName snippet.title faq.question costDetails')
     .sort({ lastEdit: -1 });

    // Get training content statistics
    const trainingStats = await TrainingList.aggregate([
      { $match: { userId: client.userId._id, isActive: { $in: [1, 2] } } },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 }
        }
      }
    ]);

    // Format message statistics
    const messageStatistics = {
      total: 0,
      bot: 0,
      agent: 0,
      visitor: 0,
      assistant: 0,
      user: 0
    };

    messageStats.forEach(stat => {
      messageStatistics[stat._id] = stat.count;
      messageStatistics.total += stat.count;
    });

    // Format training statistics
    const trainingStatistics = {
      total: trainingContent.length,
      webPage: 0,
      file: 0,
      snippet: 0,
      faq: 0
    };

    trainingStats.forEach(stat => {
      switch(stat._id) {
        case 0: trainingStatistics.webPage = stat.count; break;
        case 1: trainingStatistics.file = stat.count; break;
        case 2: trainingStatistics.snippet = stat.count; break;
        case 3: trainingStatistics.faq = stat.count; break;
      }
    });

    const response = {
      client: client.toObject(),
      agents: agents,
      conversations: {
        stats: conversationStats[0] || {
          total: 0, open: 0, closed: 0, aiChats: 0, humanChats: 0
        },
        active: activeConversations
      },
      messages: messageStatistics,
      content: {
        size: contentSize[0]?.totalSizeInBytes || 0,
        items: trainingContent,
        stats: trainingStatistics
      }
    };

    res.json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error("Error fetching client details:", error);
    res.status(500).json({ message: "Error fetching client details" });
  }
};

// Get client content size
exports.getClientContentSize = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await TrainingList.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalSizeInBytes: { $sum: { $bsonSize: "$ROOT" } }
        }
      }
    ]);

    const sizeInBytes = result[0]?.totalSizeInBytes || 0;
    const sizeInMB = (sizeInBytes / (1024 * 1024)).toFixed(2);
    const sizeInKB = (sizeInBytes / 1024).toFixed(2);

    res.json({
      success: true,
      data: {
        bytes: sizeInBytes,
        kb: parseFloat(sizeInKB),
        mb: parseFloat(sizeInMB)
      }
    });

  } catch (error) {
    console.error("Error calculating content size:", error);
    res.status(500).json({ message: "Error calculating content size" });
  }
};
