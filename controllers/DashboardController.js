const commonHelper = require("../helpers/commonHelper.js");
const Client = require("../models/Client");
// const ObjectId  = require('mongoose').Types.ObjectId;
const DashboardController = {};
DashboardController.getDashboardData = async (dateRange, userId) => {
  try {
    const { startDate, endDate } = dateRange;
    const conversationCount = await Conversation.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).countDocuments();

    const AiconversationCount = await Conversation.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
      aiChat: true,
    }).countDocuments();
    res.status(200).json(conversationCount, AiconversationCount);

    // const totalChats = await ChatMessage.find({
    //     userId: userId,
    //   }).countDocuments();
    const totalChats = await ChatMessage.find({
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).countDocuments();

    const likedChats = await ChatMessage.find({
      userId: userId,
      feedback: "like",
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).countDocuments();

    let csat = 0;

    if (totalChats && likedChats) {
      csat = (likedChats / totalChats) * 100;
    } else {
      csat = 0;
    }
    res.status(200).json({ csat: csat });

    //   res.status(200).json(chatCount);

    // const clientData = await Client.findOne({userId});
    return {
      conversationCount: conversationCount,
      AiconversationCount: AiconversationCount,
      totalChats: totalChats,
      csat: csat,
    };
  } catch (error) {
    return error;
  }
};

module.exports = DashboardController;
