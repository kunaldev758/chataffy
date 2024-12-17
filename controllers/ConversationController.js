const ConversationTag = require("../models/ConversationTag");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");
const ChatMessage = require("../models/ChatMessage");

const ConversationController = {};

//get all old conversation
ConversationController.getAllOldConversations = async (visitor_id) => {
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
    return chatMessagesNotesList;
  } catch (error) {
   return error;
  }
};

//get Open Conversation
ConversationController.getOpenConversation = async (visitorId,userId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
      conversationOpenStatus: "open",
    });
    if(!result){
      const conversation = await ConversationController.createConversation(visitorId,userId);
      return conversation;
    }
    return result;
  } catch (err) {
    throw err;
  }
};

ConversationController.createConversation = async (visitorId,userId) => {
  try {
    const result = await Conversation.create({
      visitor: visitorId,
      userId:userId,
    });
    return result;
  } catch (err) {
    throw err;
  }
};

ConversationController.updateFeedback = async (conversationId, feedback) => {
  try {
    await Conversation.findByIdAndUpdate(conversationId, { feedback: feedback });
  } catch (err) {
    throw err;
  }
};

ConversationController.disableAiChat = async ({conversationId}) => {
  try{
    await Conversation.updateOne({_id:conversationId},{aiChat:false});
    return true;
  } catch(err){
    throw err;
  }
}

ConversationController.UpdateConversationStatusOpenClose = async (
  conversationId,
  status
) => {
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

ConversationController.searchByTagOrName = async (query, userId) => {
  // const query = req.body.basicInfo;
  // const userId = req.body.userId;
  // return Conversations.find({ name: { $regex: query, $options: "i" } }).limit(
  //   10
  // );
  const visitor = await Visitor.find({ name: query, userId: userId });
  const tag = await ConversationTag.find({ name: query });
  if (visitor) {
    return visitor.conversation.id;
  }
  if (tag) {
    return tag.conversationId;
  }
};

module.exports = ConversationController;
