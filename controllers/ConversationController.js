const ConversationTag = require("../models/ConversationTag");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");
const ChatMessage = require("../models/ChatMessage");

const ConversationController = {};

//get all old conversation
ConversationController.getAllOldConversations = async (req, res) => {
  const { visitor_id } = req.body.basicInfo;
  try {
    let chatMessagesNotesList = [];
    if (visitor_id) {
      let conversation = await Conversation.find({
        visitor: visitor_id,
        conversationOpenStatus: "close",
      });
      for (let conv of conversation) {
        let chatMessagesNotes = await ChatMessage.find({
          conversation_id: conv._id,
        })
          .sort({ createdAt: -1 })
          .limit(1)
          .exec();
        chatMessagesNotesList.push(...chatMessagesNotes);
      }
    }
    res.status(200).json(chatMessagesNotesList);
  } catch (error) {
    res
      .status(500)
      .json({ error: "An error occurred while fetching chat messages" });
  }
};

//get Open Conversation
ConversationController.getOpenConversation = async (visitorId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
      conversationOpenStatus: "open",
    });
    return result;
  } catch (err) {
    throw err;
  }
};

ConversationController.createConversation = async (visitorId) => {
  try {
    const result = await Conversation.create({
      visitor: visitorId,
    });
    return result;
  } catch (err) {
    throw err;
  }
};
ConversationController.findConversation = async (visitorId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
    });
    return result;
  } catch (err) {
    throw err;
  }
};

//Add Conversation to Archive
ConversationController.AddConversationToArchive = async (req, res) => {
  const { conversationId } = req.body.basicInfo;
  try {
    if (conversationId) {
      let conversation = await Conversation.findByIdAndUpdate(conversationId, {
        isArchived: true,
      });
      res.status(200).json(conversation);
    } else {
      throw error;
    }
  } catch (error) {
    res
      .status(500)
      .json({ error: "An error occurred while fetching chat messages" });
  }
};

ConversationController.UpdateConversationStatusOpenClose = async (
  conversationId,
  status
) => {
  // const conversationId = req.params.id;
  // const { status } = req.body;
  try {
    if (conversationId) {
      if (status == "open") {
        let conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          { conversationOpenStatus: "open" }
        );
        return true;
      } else {
        let conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          { conversationOpenStatus: "close" }
        );
        return true;
      }
    } else {
      throw error;
    }
  } catch (error) {
    throw error;
  }
};

ConversationController.searchByTagOrName = async (req, res) => {
  const query = req.body.basicInfo;
  const userId = req.body.userId;
  const visitor = await Visitor.find({ name: query, userId: userId });
  const tag = await ConversationTag.find({ name: query });
  if (visitor) {
    return visitor.conversation.id;
  }
  if (tag) {
    return tag.conversationId;
  }
};

//dashboard Api
ConversationController.getTotalConversation = async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
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
  } catch (err) {
    throw err;
  }
};

module.exports = ConversationController;
