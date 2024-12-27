const commonHelper = require("../helpers/commonHelper.js");
const Client = require("../models/Client");
const Conversation = require("../models/Conversation.js");
const ChatMessage = require("../models/ChatMessage.js");
const Visitor = require("../models/Visitor.js")

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
      userId:userId
    }).countDocuments();

    const AiconversationCount = await Conversation.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      aiChat: true,
      userId:userId,
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
      userId:userId
    }).countDocuments();

    let csat = 0;

    if (conversationCount && likedConversation) {
      csat = (likedConversation / conversationCount) * 100;
    } else {
      csat = 0;
    }

    const location = await Visitor.find({userId:userId}, { location: 1, _id: 0 })
    console.log(location,"the location")
   const locationData = transformData(location)

    return {
      totalChat: conversationCount,
      aiAssists: AiconversationCount,
      totalMessage: totalMessages,
      csat: csat,
      fallbackMessage:0,
      art:4.2,
      locationData:locationData
    };
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
