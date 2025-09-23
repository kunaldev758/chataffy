// const commonHelper = require("../helpers/commonHelper.js");
const Client = require("../models/Client");
const Conversation = require("../models/Conversation.js");
const ChatMessage = require("../models/ChatMessage.js");
const Visitor = require("../models/Visitor.js")
const Agent = require("../models/Agent.js");

const DashboardController = {};
DashboardController.getDashboardData = async (dateRange, userId) => {
  try {
    const startDate = dateRange[0]; 
    const endDate  = dateRange[1];
    const conversationCount = await Conversation.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      userId:userId,
      is_started: true,
    }).countDocuments();

    const AiconversationCount = await Conversation.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      aiChat: true,
      userId:userId,
      is_started: true,
    }).countDocuments();

    const totalMessages = await ChatMessage.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      userId:userId
    }).countDocuments();

    const likedConversation = await Conversation.find({
      feedback: true,
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      userId:userId,
      is_started: true,
    }).countDocuments();

    let csat = 0;

    if (conversationCount && likedConversation) {
      csat = (likedConversation / conversationCount) * 100;
    } else {
      csat = 0;
    }

    const location = await Visitor.find({userId:userId}, { location: 1, _id: 0 })
   const locationData = transformData(location)

   //total Agents
    const totalAgents = await Agent.find({ userId: userId }).countDocuments();

    let totalChatsInPlan = 0;

      try {
        const client = await Client.findOne({userId});
      
        if (!client) throw new Error("Client not found");
      
        // For free plan → start cycle from account creation date
        const baseDate = (client.plan === "free") 
          ? new Date(client.createdAt) 
          : new Date(client.planPurchaseDate);
      
        const now = new Date();
      
        // Calculate start of the current monthly cycle
        let monthsSinceBase = 
          (now.getFullYear() * 12 + now.getMonth()) -
          (baseDate.getFullYear() * 12 + baseDate.getMonth());
      
        let cycleStart = new Date(baseDate);
        cycleStart.setMonth(baseDate.getMonth() + monthsSinceBase);
      
        let cycleEnd = new Date(cycleStart);
        cycleEnd.setMonth(cycleStart.getMonth() + 1);
      
        // Count chats in the current cycle
        totalChatsInPlan = await Conversation.countDocuments({
          userId,
          is_started: true,
          createdAt: { $gte: cycleStart, $lt: cycleEnd }
        });
      
      } catch (e) {
        console.error(e);
        totalChatsInPlan = 0;
      }

    return {
      totalChat: conversationCount,
      aiAssists: AiconversationCount,
      totalMessage: totalMessages,
      csat: csat,
      totalAgents:totalAgents,
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
  } catch (error) {
    return error;
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
