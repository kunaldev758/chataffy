const SuperAdmin = require("../models/SuperAdmin");
const Client = require("../models/Client");
const Plan = require("../models/Plan");
const Agent = require("../models/Agent");
const HumanAgent = require("../models/HumanAgent");
const Conversation = require("../models/Conversation");
const ChatMessage = require("../models/ChatMessage");
const Visitor = require("../models/Visitor");
const PlanService = require("../services/PlanService")
const UsageTrackingService= require("../services/UsageTrackingService")
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  SUPERADMIN_TOKEN_COOKIE,
  DEFAULT_SUPERADMIN_COOKIE_PATH,
  getSuperAdminCookiePath,
  getSuperAdminCookieOptions,
  getSuperAdminClearCookieOptions,
} = require("../constants/superAdminCookie");
const User = require("../models/User");
const ImpersonationSession = require("../models/ImpersonationSession");
const {AiModelsCategory,AiModel} = require("../models/AiModel");
const { default: mongoose } = require("mongoose");
const { clearModelCache } = require("../services/aiModelService");
const {
  getOrCreateSettings,
  updateScrapeProxySettings,
  toPublicSettings,
  validateProxySettingsPayload,
} = require("../services/scraperSettingsService");

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

    res.cookie(
      SUPERADMIN_TOKEN_COOKIE,
      token,
      getSuperAdminCookieOptions(req)
    );

    res.json({
      message: "Login successful",
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

module.exports.superAdminMe = async (req, res) => {
  try {
    const row = await SuperAdmin.findById(req.superAdmin.id).select(
      "name email role isActive lastLogin"
    );
    if (!row || !row.isActive) {
      return res.status(401).json({ message: "Invalid token or account deactivated." });
    }
    res.json({
      superAdmin: {
        id: row._id,
        name: row.name,
        email: row.email,
        role: row.role,
        isActive: row.isActive,
        lastLogin: row.lastLogin,
      },
    });
  } catch (error) {
    console.error("SuperAdmin me error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports.superAdminLogout = (req, res) => {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = "lax";
  const httpOnly = true;
  res.clearCookie(SUPERADMIN_TOKEN_COOKIE, getSuperAdminClearCookieOptions(req));
  // Clear other possible paths to avoid “sticky” cookies after routing changes.
  const pathsToClear = new Set([DEFAULT_SUPERADMIN_COOKIE_PATH, getSuperAdminCookiePath()]);
  for (const path of pathsToClear) {
    if (!path) continue;
    res.clearCookie(SUPERADMIN_TOKEN_COOKIE, { path, httpOnly, secure, sameSite });
  }
  /* remove tokens issued before cookie path was scoped to /api/superadmin */
  res.clearCookie(SUPERADMIN_TOKEN_COOKIE, {
    path: "/",
    httpOnly,
    secure,
    sameSite,
  });
  res.json({ message: "Logged out" });
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

    // 10. OpenAI Usage (all users) — overall totals + per-type breakdown
    const [openAIUsageAgg, openAIUsageByTypeAgg] = await Promise.all([
      UsageTrackingService.getOpenAIUsage(undefined),
      UsageTrackingService.getOpenAIUsageByType(undefined),
    ]);
    const openAIUsage = openAIUsageAgg || {
      totalTokens: 0, totalCost: 0, totalRequests: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalCacheTokens: 0,
      totalInputCost: 0, totalOutputCost: 0, totalCacheCost: 0,
    };
    const openAIUsageByType = openAIUsageByTypeAgg || { byType: {}, totals: {} };

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
        // Grand totals across all types
        totalInputTokens: openAIUsage.totalInputTokens || 0,
        totalOutputTokens: openAIUsage.totalOutputTokens || 0,
        totalCacheTokens: openAIUsage.totalCacheTokens || 0,
        totalTokens: openAIUsage.totalTokens || 0,
        totalInputCost: openAIUsage.totalInputCost || 0,
        totalOutputCost: openAIUsage.totalOutputCost || 0,
        totalCacheCost: openAIUsage.totalCacheCost || 0,
        totalCost: openAIUsage.totalCost || 0,
        totalRequests: openAIUsage.totalRequests || 0,
        
        // Full dynamic breakdown for any custom categories added by the super admin
        byType: openAIUsageByType.byType || {},
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

/** Enrich a page of client docs with plan usage (only runs for the current page, not the full collection). */
async function enrichClientsPage(clients) {
  if (!clients.length) return [];

  const userIds = clients.map((c) => c.userId).filter(Boolean);
  const agentTrainingStatsByUserId = new Map();
  if (userIds.length > 0) {
    const agentStatsAgg = await Agent.aggregate([
      { $match: { userId: { $in: userIds }, isDeleted: { $ne: true } } },
      {
        $group: {
          _id: "$userId",
          pagesSuccess: { $sum: { $ifNull: ["$pagesAdded.success", 0] } },
          pagesFailed: { $sum: { $ifNull: ["$pagesAdded.failed", 0] } },
          pagesTotal: { $sum: { $ifNull: ["$pagesAdded.total", 0] } },
          filesAdded: { $sum: { $ifNull: ["$filesAdded", 0] } },
          faqsAdded: { $sum: { $ifNull: ["$faqsAdded", 0] } },
        },
      },
    ]);
    for (const row of agentStatsAgg) {
      agentTrainingStatsByUserId.set(String(row._id), row);
    }
  }

  return Promise.all(
    clients.map(async (client) => {
      const st = client.userId
        ? agentTrainingStatsByUserId.get(String(client.userId))
        : null;
      client.pagesAdded = {
        success: st?.pagesSuccess ?? 0,
        failed: st?.pagesFailed ?? 0,
        total: st?.pagesTotal ?? 0,
      };
      client.filesAdded = st?.filesAdded ?? 0;
      client.faqsAdded = st?.faqsAdded ?? 0;

      const planDetails = await PlanService.getUserPlan(client.userId);

      if (!planDetails) {
        return client;
      }

      const totalAiAgents = await Agent.countDocuments({
        userId: client.userId,
        isDeleted: { $ne: true },
      });
      // Team "Admin" is stored as HumanAgent with isClient: true; only invited agents (isClient: false) count toward plan limits
      const totalHumanAgents = await HumanAgent.countDocuments({
        userId: client.userId,
        isDeleted: false,
        isClient: false,
      });

      const totalConversations = await PlanService.countVisitorQueriesInBillingCycle(client.userId);

      const currentDataUsed = client.currentDataSize;

      const effectiveLimits = await PlanService.getEffectiveLimits(client.userId);

      client.usageDetails = {
        maxAgents: effectiveLimits.maxAgentsPerAccount,
        maxHumanAgents: effectiveLimits.maxHumanAgentsPerAccount,
        totalAgents: totalAiAgents,
        totalAiAgents,
        totalHumanAgents,
        maxStorage: effectiveLimits.maxStorage,
        currentDataUsed,
        maxQueries: effectiveLimits.maxQueries,
        totalConversations,
        isCustomLimits: effectiveLimits.isCustom,
      };

      return client;
    })
  );
}

// GET /superadmin/clients?page=&limit=&sortBy=&sortOrder=&search=
module.exports.getAllClients = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 10));
    const skip = (page - 1) * limit;
    const sortBy = req.query.sortBy || "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const search = String(req.query.search || "").trim();

    const matchFilter = { isDeleted: false };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(escaped, "i");
      matchFilter.$or = [{ email: rx }, { plan: rx }];
    }

    const totalCount = await Client.countDocuments(matchFilter);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);

    const agentsColl = Agent.collection.name;
    const convColl = Conversation.collection.name;

    let clientsPage = [];

    if (sortBy === "agents") {
      const pipeline = [
        { $match: matchFilter },
        {
          $lookup: {
            from: agentsColl,
            let: { uid: "$userId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
              { $match: { isDeleted: { $ne: true } } },
              { $count: "c" },
            ],
            as: "_aiAgg",
          },
        },
        {
          $addFields: {
            _sortAgents: { $ifNull: [{ $arrayElemAt: ["$_aiAgg.c", 0] }, 0] },
          },
        },
        { $sort: { _sortAgents: sortOrder } },
        { $skip: skip },
        { $limit: limit },
        { $project: { _aiAgg: 0, _sortAgents: 0 } },
      ];
      clientsPage = await Client.aggregate(pipeline);
    } else if (sortBy === "conversations") {
      const pipeline = [
        { $match: matchFilter },
        {
          $lookup: {
            from: convColl,
            let: { uid: "$userId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
              { $count: "c" },
            ],
            as: "_convAgg",
          },
        },
        {
          $addFields: {
            _sortConvs: { $ifNull: [{ $arrayElemAt: ["$_convAgg.c", 0] }, 0] },
          },
        },
        { $sort: { _sortConvs: sortOrder } },
        { $skip: skip },
        { $limit: limit },
        { $project: { _convAgg: 0, _sortConvs: 0 } },
      ];
      clientsPage = await Client.aggregate(pipeline);
    } else {
      const sortFieldMap = {
        email: "email",
        plan: "plan",
        contentSize: "currentDataSize",
        totalAmountPaid: "totalAmountPaid",
        createdAt: "createdAt",
      };
      const mongoField = sortFieldMap[sortBy] || "createdAt";
      const sortSpec = { [mongoField]: sortOrder };
      clientsPage = await Client.find(matchFilter).sort(sortSpec).skip(skip).limit(limit).lean();
    }

    const data = await enrichClientsPage(clientsPage);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ message: "Error fetching clients" });
  }
};

module.exports.getClientById = async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ _id: clientId, isDeleted: false }).lean();
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    const [data] = await enrichClientsPage([client]);
    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching client:", error);
    res.status(500).json({ message: "Error fetching client" });
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

    const [aiAgents, humanAgents, openAIGrouped] = await Promise.all([
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
      UsageTrackingService.getOpenAIUsageGroupedByAgent(client.userId),
    ]);

    const byAgent = openAIGrouped?.byAgent || {};
    const empty = UsageTrackingService.emptyUsageTotals();
    const aiAgentsWithUsage = aiAgents.map((bot) => {
      const bucket = byAgent[String(bot._id)] || {};
      return {
        ...bot,
        openAIUsage: bucket.openAIUsage || { ...empty },
        embeddingUsage: bucket.embeddingUsage || { ...empty },
      };
    });

    res.status(200).json({
      success: true,
      data: {
        aiAgents: aiAgentsWithUsage,
        humanAgents,
        openAIUsageTotal: openAIGrouped?.totals || empty,
      },
    });
  } catch (error) {
    console.error("Error fetching client agents:", error);
    res.status(500).json({ message: "Error fetching client agents" });
  }
};

/**
 * Per-conversation OpenAI usage for one AI chatbot under a client.
 * Lists real Chat Logs conversations for the agent, then merges usage when present.
 * GET /superadmin/clients/:clientId/agents/:agentId/conversations-usage
 */
module.exports.getAgentConversationsUsage = async (req, res) => {
  try {
    const { clientId, agentId } = req.params;
    const client = await Client.findById(clientId).lean();
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const agent = await Agent.findOne({
      _id: agentId,
      userId: client.userId,
      isDeleted: { $ne: true },
    })
      .select("agentName website_name")
      .lean();

    if (!agent) {
      return res.status(404).json({ message: "AI chatbot not found for this client" });
    }

    const emptyConvUsage = () => ({
      ...UsageTrackingService.emptyUsageTotals(),
      embeddingInputTokens: 0,
      embeddingInputCost: 0,
      embeddingTotalTokens: 0,
      embeddingTotalRequests: 0,
    });


    // check on promise on all for usage grouped by conversation, conversation docs and agent usage map

    const [usageGrouped, convDocs, agentUsageMap] = await Promise.all([
      UsageTrackingService.getOpenAIUsageGroupedByConversation(
        client?.userId,
        agentId
      ),
      // Same basis as Inbox Chat Logs for this chatbot
      Conversation.find({
        userId: client?.userId,
        agentId,
        is_started: true,
      })
        .select("_id visitor createdAt updatedAt")
        .sort({ updatedAt: -1 })
        .lean(),
      UsageTrackingService.getOpenAIUsageGroupedByAgent(client?.userId),
    ]);

    console.log("Convo docs check : ", convDocs, "Usage grouped check : ", usageGrouped.conversations?.length);

    const usageByConvId = new Map(
      (usageGrouped?.conversations || []).map((c) => [
        String(c.conversationId),
        c,
      ])
    );

    const visitorIds = [
      ...new Set(
        convDocs
          .map((c) => c.visitor)
          .filter(Boolean)
          .map((v) => String(v))
      ),
    ];

    const visitors =
      visitorIds?.length > 0
        ? await Visitor.find({ _id: { $in: visitorIds } })
            .select("_id name")
            .lean()
        : [];
    const visitorById = new Map(visitors.map((v) => [String(v._id), v]));

    const seen = new Set();
    const conversationsWithVisitor = convDocs?.map((conv) => {
      const id = String(conv._id);
      seen.add(id);
      const usage = usageByConvId.get(id) || emptyConvUsage();
      const visitorId = conv.visitor ? String(conv.visitor) : null;
      const visitor = visitorId ? visitorById.get(visitorId) : null;
      return {
        ...usage,
        conversationId: id,
        visitorId,
        visitorName: visitor?.name || "Unknown visitor",
        conversationCreatedAt: conv.createdAt || null,
        conversationUpdatedAt: conv.updatedAt || null,
      };
    });

    // Keep any usage rows whose conversation is missing / not is_started
    const orphanIds = (usageGrouped?.conversations || [])
      .map((c) => String(c.conversationId))
      .filter((id) => id && !seen.has(id));

    if (orphanIds.length > 0) {
      const orphanDocs = await Conversation.find({ _id: { $in: orphanIds } })
        .select("_id visitor createdAt updatedAt")
        .lean();
      const orphanById = new Map(orphanDocs.map((c) => [String(c._id), c]));
      const orphanVisitorIds = [
        ...new Set(
          orphanDocs
            .map((c) => c.visitor)
            .filter(Boolean)
            .map((v) => String(v))
        ),
      ];
      const orphanVisitors =
        orphanVisitorIds?.length > 0
          ? await Visitor.find({ _id: { $in: orphanVisitorIds } })
              .select("_id name")
              .lean()
          : [];
      const orphanVisitorById = new Map(
        orphanVisitors?.map((v) => [String(v._id), v])
      );

      for (const row of usageGrouped?.conversations || []) {
        const id = String(row?.conversationId);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const conv = orphanById.get(id);
        const visitorId = conv?.visitor ? String(conv.visitor) : null;
        const visitor = visitorId ? orphanVisitorById.get(visitorId) : null;
        conversationsWithVisitor.push({
          ...row,
          conversationId: id,
          visitorId,
          visitorName: visitor?.name || "Unknown visitor",
          conversationCreatedAt: conv?.createdAt || null,
          conversationUpdatedAt: conv?.updatedAt || null,
        });
      }
    }

    // Same order as Inbox Chat Logs (lastActivity): newest updatedAt first
    conversationsWithVisitor.sort((a, b) => {
      const dateA = new Date(
        a.conversationUpdatedAt || a.conversationCreatedAt || 0
      ).getTime();
      const dateB = new Date(
        b.conversationUpdatedAt || b.conversationCreatedAt || 0
      ).getTime();
      return dateB - dateA;
    });

    const agentBucket = agentUsageMap.byAgent[String(agentId)] || {};
    const empty = UsageTrackingService.emptyUsageTotals();
    const embeddingUsage = agentBucket.embeddingUsage || empty;
    const agentTotals = agentBucket.openAIUsage || empty;

    // Prefer attributed conversation chat totals; fall back to agent-level totals
    // so the panel matches the chatbot card when usage lacked conversationId.
    const attributed = usageGrouped?.totals || {
      ...empty,
      embeddingInputTokens: 0,
      embeddingInputCost: 0,
    };
    const conversationsTotals = {
      ...(attributed.totalTokens > 0 || attributed?.totalCost > 0
        ? attributed
        : {
            ...agentTotals,
            embeddingInputTokens: attributed?.embeddingInputTokens || 0,
            embeddingInputCost: attributed?.embeddingInputCost || 0,
          }),
      embeddingInputTokens:
        attributed?.embeddingInputTokens || embeddingUsage.inputTokens || 0,
      embeddingInputCost:
        attributed?.embeddingInputCost || embeddingUsage.inputCost || 0,
    };

    res.status(200).json({
      success: true,
      data: {
        agent: {
          _id: agent._id,
          agentName: agent.agentName,
          website_name: agent.website_name,
        },
        conversationsTotals,
        agentTotals,
        embeddingUsage,
        conversations: conversationsWithVisitor,
      },
    });
  } catch (error) {
    console.error("Error fetching agent conversations usage:", error);
    res.status(500).json({ message: "Error fetching agent conversations usage" });
  }
};

/**
 * OpenAI usage breakdown for one conversation.
 * GET /superadmin/clients/:clientId/conversations/:conversationId/usage
 */
module.exports.getConversationOpenAIUsage = async (req, res) => {
  try {
    const { clientId, conversationId } = req.params;
    const client = await Client.findById(clientId).lean();
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      userId: client.userId,
    })
      .select("_id visitor agentId createdAt")
      .lean();

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const [usage, visitor] = await Promise.all([
      UsageTrackingService.getOpenAIUsageForConversation(
        client.userId,
        conversationId
      ),
      conversation.visitor
        ? Visitor.findById(conversation.visitor).select("name").lean()
        : null,
    ]);

    res.status(200).json({
      success: true,
      data: {
        conversationId: String(conversation._id),
        visitorId: conversation.visitor ? String(conversation.visitor) : null,
        visitorName: visitor?.name || "Unknown visitor",
        agentId: conversation.agentId ? String(conversation.agentId) : null,
        openAIUsage: usage,
      },
    });
  } catch (error) {
    console.error("Error fetching conversation OpenAI usage:", error);
    res.status(500).json({ message: "Error fetching conversation OpenAI usage" });
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

    const freePlan = await Plan.getPlanByName("free");
    client.customLimits = PlanService.buildCustomLimitsFromPlan(freePlan);

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

module.exports.setCustomLimits = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { isCustomLimits, maxQueries, maxHumanAgents, maxAgents, maxStorage } = req.body;

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const planDoc = await Plan.getPlanByName(client.plan);
    const plim = planDoc?.limits || {};

    const mergeDim = (bodyVal, planVal) => {
      if (bodyVal !== undefined && bodyVal !== null && bodyVal !== "") {
        const n = Number(bodyVal);
        return Number.isFinite(n) ? n : null;
      }
      return planVal != null ? Number(planVal) : null;
    };

    if (!isCustomLimits) {
      client.customLimits = {
        isCustomLimits: false,
        maxQueries: null,
        maxHumanAgents: null,
        maxAgents: null,
        maxStorage: null,
      };
    } else {
      // Missing/null body fields default to the client's current global plan limits
      client.customLimits = {
        isCustomLimits: true,
        maxQueries: mergeDim(maxQueries, plim.maxQueries),
        maxHumanAgents: mergeDim(maxHumanAgents, plim.maxHumanAgentsPerAccount),
        maxAgents: mergeDim(maxAgents, plim.maxAgentsPerAccount),
        maxStorage: mergeDim(maxStorage, plim.maxStorage),
      };
    }

    if (client.customLimits.isCustomLimits) {
      const userId = client.userId;

      const [totalAiAgents, totalHumanAgents, visitorQueriesInCycle] = await Promise.all([
        Agent.countDocuments({ userId, isDeleted: { $ne: true } }),
        HumanAgent.countDocuments({ userId, isDeleted: false, isClient: false }),
        PlanService.countVisitorQueriesInBillingCycle(userId),
      ]);

      const cl = client.customLimits;
      const effectiveMaxAgents = cl.maxAgents;
      const effectiveMaxHumanAgents = cl.maxHumanAgents;
      const effectiveMaxQueries = cl.maxQueries;
      const effectiveMaxStorage = cl.maxStorage;

      const upgradePlanStatus = { ...client.upgradePlanStatus.toObject?.() || client.upgradePlanStatus };

      if (effectiveMaxAgents != null) {
        upgradePlanStatus.agentLimitExceeded = totalAiAgents > effectiveMaxAgents;
      }
      if (effectiveMaxHumanAgents != null) {
        upgradePlanStatus.humanAgentLimitExceeded = totalHumanAgents > effectiveMaxHumanAgents;
      }
      if (effectiveMaxQueries != null) {
        upgradePlanStatus.chatLimitExceeded = visitorQueriesInCycle > effectiveMaxQueries;
      }
      if (effectiveMaxStorage != null) {
        upgradePlanStatus.storageLimitExceeded = client.currentDataSize > effectiveMaxStorage;
      }

      client.upgradePlanStatus = upgradePlanStatus;
    }

    await client.save();

    res.status(200).json({
      success: true,
      message: client.customLimits.isCustomLimits
        ? "Limits saved successfully"
        : "Per-client limits cleared; global plan limits apply",
      data: {
        customLimits: client.customLimits,
        upgradePlanStatus: client.upgradePlanStatus,
      },
    });
  } catch (error) {
    console.error("Error setting custom limits:", error);
    res.status(500).json({ message: "Error setting custom limits" });
  }
};


// dirct client login 


module.exports.directClientLogin = async (req, res) => {
  try {
    console.log("inside direct client login",req.params);
    const { clientId } = req.params;
    const client = await Client.findById(clientId);

    if(!client){

      return res.status(404).json({ message: "Client not found" });
    }

    // fetch user information 

    const user = await User.findById(client.userId);
    if (!user || user.isDeleted) {
      return res.status(404).json({ message: "User not found" });
    }

    const jti = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

    const expiresInSeconds = 15 * 60; // 15 minutes
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await ImpersonationSession.create({
      jti,
      userId: user._id,
      clientId: client._id,
      superAdminId: req.superAdmin?.id,
      expiresAt,
    });

    const tokenData = jwt.sign(
      {
        _id: user._id,
        email: user.email,
        role: user.role,
        purpose: "impersonation",
        jti,
        impersonatedBy: req.superAdmin?.id,
      },
      process.env.JWT_SECRET_KEY,
      { expiresIn: expiresInSeconds }
    );


    console.log("token data to send : ",tokenData);
    return res.status(200).json({

      success: true,
      token: tokenData,
      expiresAt,
      message: "Client login successful",
    });

  } catch (error) {
    console.error("Error direct client login:", error);
    res.status(500).json({ message: "Error direct client login" });
  }
};

// ================================ AI Models ================================
module.exports.getAllAiModels = async (req, res) => {
  try {
    const aiModels = await AiModel.find({}).lean().populate("categories").lean();
    if(!aiModels || aiModels.length === 0) {
      return res.status(404).json({ message: "No AI models found" });
    }
    res.status(200).json({
      success: true,
      data: aiModels,
    });
  } catch (error) {
    console.error("Error fetching ai models:", error);
    res.status(500).json({ message: "Error fetching ai models" });
  }
};


module.exports.createAiModel = async (req, res) => {
  try {
    const {
      model,
      status,
      inputCost,
      outputCost,
      cacheCost,
      categories,
      provider,
      embeddingDimension,
      providerConfig,
    } = req.body;

    const validation = validateAiModel({
      model,
      status,
      inputCost,
      outputCost,
      cacheCost,
      categories,
      provider,
      embeddingDimension,
      providerConfig,
    });
    if (!validation.success) {
      return res.status(400).json({ message: validation.message });
    }

    const aiModel = await AiModel.create({
      model,
      status,
      inputCost,
      outputCost,
      cacheCost,
      categories,
      provider: validation.data.provider,
      embeddingDimension: validation.data.embeddingDimension,
      providerConfig: validation.data.providerConfig,
    });

    if (categories?.length) {
      await AiModel.updateMany(
        { _id: { $ne: aiModel._id } },
        { $pull: { categories: { $in: categories } } }
      );
    }

    clearModelCache();

    res.status(200).json({ success: true, data: aiModel });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Ai model already exists" });
    }
    console.error("Error creating ai model:", error);
    res.status(500).json({ message: "Error creating ai model" });
  }
};

module.exports.updateAiModel = async (req, res) => {
  try {
    const {
      modelId,
      model,
      status,
      inputCost,
      outputCost,
      cacheCost,
      categories,
      provider,
      embeddingDimension,
      providerConfig,
    } = req.body;

    const validation = validateAiModel({
      model,
      status,
      inputCost,
      outputCost,
      cacheCost,
      categories,
      provider,
      embeddingDimension,
      providerConfig,
    });
    if (!validation.success) {
      return res.status(400).json({ message: validation.message });
    }

    const updated = await AiModel.findByIdAndUpdate(
      modelId,
      {
        model,
        status,
        inputCost,
        outputCost,
        cacheCost,
        categories,
        provider: validation.data.provider,
        embeddingDimension: validation.data.embeddingDimension,
        providerConfig: validation.data.providerConfig,
      },
      { new: true }
    );

   if (categories?.length && updated) {
     // Remove the categories from all other models
      await AiModel.updateMany(
        { _id: { $ne: updated._id } },
        { $pull: { categories: { $in: categories } } }
      );

      // Mark inactive only if no categories remain
      await AiModel.updateMany(
        {
          _id: { $ne: updated._id },
          categories: { $size: 0 },
        },
        {
          $set: { status: "inactive" },
        }
      );
    }

    clearModelCache();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Error updating ai model:", error);
    if (error.code === 11000) return res.status(400).json({ message: "Ai model already exists" });
    res.status(500).json({ message: "Error updating ai model" });
  }
};

module.exports.deleteAiModel = async (req, res) => {
  try {
    const { modelId } = req.params;
    const deletedModel = await AiModel.findByIdAndDelete(modelId);
    if (!deletedModel) {
      return res.status(404).json({ message: "Ai model not found" });
    }
    clearModelCache();
    res.status(200).json({ success: true, message: "Ai model deleted successfully" });
  } catch (error) {
    console.error("Error deleting ai model:", error);
    res.status(500).json({ message: error.message || "Error deleting ai model" });
  }
};


function validateAiModel({
  model,
  status,
  inputCost,
  outputCost,
  cacheCost,
  categories,
  provider,
  embeddingDimension,
  providerConfig,
}) {
  if (!model || !status) {
    return { success: false, message: "Model and status are required" };
  }

  if (inputCost == null || outputCost == null || cacheCost == null) {
    return { success: false, message: "All cost fields are required" };
  }

  if (!categories) {
    return { success: false, message: "Categories are required" };
  }

  if (status !== "active" && status !== "inactive") {
    return { success: false, message: "Status must be active or inactive" };
  }

  if (inputCost < 0 || outputCost < 0 || cacheCost < 0) {
    return { success: false, message: "Costs must not be negative" };
  }

  if (!Array.isArray(categories) || categories.length === 0) {
    return { success: false, message: "Categories must be a non-empty array" };
  }

  if (categories.some((c) => !mongoose.Types.ObjectId.isValid(c))) {
    return { success: false, message: "Categories must be an array of valid ObjectIds" };
  }

  const resolvedProvider = String(provider || "openai").toLowerCase();
  if (!["openai", "ollama", "groq"].includes(resolvedProvider)) {
    return { success: false, message: "Provider must be openai, ollama, or groq" };
  }

  const cfg = providerConfig && typeof providerConfig === "object" ? providerConfig : {};
  const timeoutMs = cfg.timeoutMs != null ? Number(cfg.timeoutMs) : 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { success: false, message: "timeoutMs must be a positive number" };
  }

  let resolvedDimension = null;
  if (embeddingDimension != null && embeddingDimension !== "") {
    resolvedDimension = Number(embeddingDimension);
    if (!Number.isFinite(resolvedDimension) || resolvedDimension <= 0) {
      return { success: false, message: "embeddingDimension must be a positive number" };
    }
  }

  // baseUrl / apiKey are optional overrides (env wins at runtime for local vs prod)
  const normalizedConfig = {
    apiKey: String(cfg.apiKey || "").trim(),
    baseUrl: String(cfg.baseUrl || "").trim(),
    timeoutMs,
    deploymentName: String(cfg.deploymentName || "").trim(),
    organization: String(cfg.organization || "").trim(),
    project: String(cfg.project || "").trim(),
    apiVersion: String(cfg.apiVersion || "").trim(),
  };

  return {
    success: true,
    message: "Validation successful",
    data: {
      provider: resolvedProvider,
      embeddingDimension: resolvedDimension,
      providerConfig: normalizedConfig,
    },
  };
}


// ===================== AI Model Categories =====================
module.exports.getAllAiModelCategories = async (req, res) => {
  try {
    const categories = await AiModelsCategory.find({}).lean();
    res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("Error fetching ai model categories:", error);
    res.status(500).json({ message: "Error fetching ai model categories" });
  }
};

module.exports.createAiModelCategory = async (req, res) => {
  try {
    const rawName = req.body.category || req.body.name;
    if (!rawName || typeof rawName !== "string" || rawName.trim().length === 0) {
      return res.status(400).json({ message: "Category name is required and must be a non-empty string" });
    }

    const category = await AiModelsCategory.create({ category: rawName.trim() });
    clearModelCache();
    res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error("Error creating ai model category:", error);
    if(error.code === 11000) {
      return res.status(400).json({ message: "Category with this name already exists" });
    }
    res.status(500).json({ message: "Error creating ai model category" });
  }
};

module.exports.updateAiModelCategory = async (req, res) => {
  try {
    const { categoryId } = req.body;
    const rawName = req.body.category || req.body.name;
    if (!rawName || typeof rawName !== "string" || rawName.trim().length === 0) {
      return res.status(400).json({ message: "Category name is required and must be a non-empty string" });
    }

    const existingCategory = await AiModelsCategory.findOne({ category: rawName.trim(), _id: { $ne: categoryId } }).lean();
    if (existingCategory) {
      return res.status(400).json({ message: "Another category with this name already exists" });
    }

    const updatedCategory = await AiModelsCategory.findByIdAndUpdate(
      categoryId,
      { category: rawName.trim() },
      { new: true }
    );

    if (!updatedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    clearModelCache();

    res.status(200).json({ success: true, data: updatedCategory });
  } catch (error) {
    console.error("Error updating ai model category:", error);
    res.status(500).json({ message: "Error updating ai model category" });
  }
};

module.exports.deleteAiModelCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await AiModelsCategory.findById(categoryId).lean();
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Remove this category from all AiModels that reference it
    await AiModel.updateMany(
      { categories: categoryId },
      { $pull: { categories: categoryId } }
    );

    // Delete the category
    await AiModelsCategory.findByIdAndDelete(categoryId);

    clearModelCache();

    res.status(200).json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    console.error("Error deleting ai model category:", error);
    res.status(500).json({ message: "Error deleting ai model category" });
  }
};

// ===================== IP Proxy Settings =====================
module.exports.getScrapeProxySettings = async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.status(200).json({
      success: true,
      data: toPublicSettings(settings),
    });
  } catch (error) {
    console.error("Error fetching scrape proxy settings:", error);
    res.status(500).json({ message: "Error fetching proxy settings" });
  }
};

module.exports.updateScrapeProxySettings = async (req, res) => {
  try {
    const validation = validateProxySettingsPayload(req.body || {});
    if (!validation.success) {
      return res.status(400).json({ message: validation.message });
    }

    const settings = await updateScrapeProxySettings(req.body || {});
    res.status(200).json({
      success: true,
      data: toPublicSettings(settings),
      message: "Proxy settings updated successfully",
    });
  } catch (error) {
    console.error("Error updating scrape proxy settings:", error);
    res.status(500).json({ message: "Error updating proxy settings" });
  }
};