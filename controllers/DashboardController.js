// const commonHelper = require("../helpers/commonHelper.js");
const Client = require("../models/Client");
const PlanService = require("../services/PlanService.js");
const Conversation = require("../models/Conversation.js");
const ChatMessage = require("../models/ChatMessage.js");
const Visitor = require("../models/Visitor.js")
const Agent = require("../models/Agent.js");
const HumanAgent = require("../models/HumanAgent.js");

const DashboardController = {};

/**
 * Open, engaged conversations — same basis as Chat Logs / `get-open-conversations-list`:
 * `is_started` + `conversationOpenStatus: "open"`. Closed threads are excluded so the
 * Live Traffic Map and Total Chats reflect live volume (e.g. 5), not open+closed (7).
 */
function liveDashboardChatPeriodMatch(userId, startDate, endDate, agentId) {
  const q = {
    userId,
    createdAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    },
    is_started: true,
    conversationOpenStatus: { $in: ["open", "close"] }, // 👈 change here
  };

  if (agentId !== undefined && agentId !== null) {
    q.agentId = agentId;
  }

  return q;
}
/** Counts per country from live chats in the period (matches totalChat). */
async function buildLocationDataFromStartedChats(match) {
  const conversations = await Conversation.find(match).select("visitor").lean();
  if (!conversations.length) return transformData([]);

  const visitorIds = [...new Set(conversations.map((c) => c.visitor).filter(Boolean))];
  const visitors = await Visitor.find({ _id: { $in: visitorIds } })
    .select("location")
    .lean();

  const idToLocation = new Map();
  for (const v of visitors) {
    idToLocation.set(String(v._id), v.location || "UNKNOWN");
  }

  const locationRows = conversations.map((c) => ({
    location: idToLocation.get(String(c.visitor)) || "UNKNOWN",
  }));
  return transformData(locationRows);
}

DashboardController.getDashboardDataForAgent = async (dateRange, userId, agentId) => {
  try {
    const startDate = dateRange[0]; 
    const endDate  = dateRange[1];
    const conversationCount = await Conversation.countDocuments(
      liveDashboardChatPeriodMatch(userId, startDate, endDate, agentId)
    );

    const AiconversationCount = await Conversation.countDocuments({
      ...liveDashboardChatPeriodMatch(userId, startDate, endDate, agentId),
      aiChat: true,
    });

    const totalMessages = await ChatMessage.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      userId:userId,
      agentId: agentId,
    }).countDocuments();

    const likedConversation = await Conversation.countDocuments({
      ...liveDashboardChatPeriodMatch(userId, startDate, endDate, agentId),
      feedback: true,
    });

    let csat = 0;

    if (conversationCount && likedConversation) {
      csat = (likedConversation / conversationCount) * 100;
    } else {
      csat = 0;
    }

    const locationData = await buildLocationDataFromStartedChats(
      liveDashboardChatPeriodMatch(userId, startDate, endDate, agentId)
    );

   //total Agents
    const [totalHumanAgents, totalAiAgents] = await Promise.all([
      HumanAgent.countDocuments({ userId: userId, isClient: false }),
      Agent.countDocuments({ userId: userId, isDeleted: { $ne: true } }),
    ]);

    let totalChatsInPlan = 0;
    try {
      totalChatsInPlan = await PlanService.countVisitorQueriesInBillingCycle(userId);
    } catch (e) {
      console.error(e);
      totalChatsInPlan = 0;
    }

    return {
      totalChat: conversationCount,
      aiAssists: AiconversationCount,
      totalMessage: totalMessages,
      csat: csat,
      totalHumanAgents,
      totalAiAgents,
      locationData,
      totalChatsInPlan,
    };
  } catch (error) {
    return error;
  }
};


DashboardController.getDashboardData = async (dateRange, userId) => {
  try {
    const startDate = dateRange[0]; 
    const endDate  = dateRange[1];
    const conversationCount = await Conversation.countDocuments(
      liveDashboardChatPeriodMatch(userId, startDate, endDate, undefined)
    );

    const AiconversationCount = await Conversation.countDocuments({
      ...liveDashboardChatPeriodMatch(userId, startDate, endDate, undefined),
      aiChat: true,
    });

    const totalMessages = await ChatMessage.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      userId:userId
    }).countDocuments();

    const likedConversation = await Conversation.countDocuments({
      ...liveDashboardChatPeriodMatch(userId, startDate, endDate, undefined),
      feedback: true,
    });

    let csat = 0;

    if (conversationCount && likedConversation) {
      csat = (likedConversation / conversationCount) * 100;
    } else {
      csat = 0;
    }

    const locationData = await buildLocationDataFromStartedChats(
      liveDashboardChatPeriodMatch(userId, startDate, endDate, undefined)
    );

   //total Agents
    const totalHumanAgents = await HumanAgent.find({ userId: userId, isClient: false }).countDocuments();

    let totalChatsInPlan = 0;
    try {
      totalChatsInPlan = await PlanService.countVisitorQueriesInBillingCycle(userId);
    } catch (e) {
      console.error(e);
      totalChatsInPlan = 0;
    }

    return {
      totalChat: conversationCount,
      aiAssists: AiconversationCount,
      totalMessage: totalMessages,
      csat: csat,
      totalHumanAgents:totalHumanAgents,
      locationData:locationData,
      totalChatsInPlan:totalChatsInPlan,
    };
  } catch (error) {
    return error;
  }
};

DashboardController.getUsageAnalytics = async (userId) => {
  try {
    const data = await Client.findOne({userId});
    return data;
    return error;
  } catch (error) {
  }
};

function transformData(data) {
  const countryMap = new Map();

  // Count occurrences of each location
  data.forEach((item) => {
    const location = item.location || "UNKNOWN"; // Handle missing locations
    countryMap.set(location, (countryMap.get(location) || 0) + 1);
  });

  // Convert map to desired array format
  const result = [["Country", "Chat Count"]];
  for (const [key, value] of countryMap.entries()) {
    // Add human-readable country names if needed
    const countryName = key === "IN" ? "INDIA" : key === "PK" ? "PAKISTAN" : key;
    result.push([key, value]);
  }

  return result;
}

module.exports = DashboardController;
