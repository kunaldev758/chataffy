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
          .sort({ createdAt: -1 });
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
  try {
    // Split the query into individual words
    const queryWords = query.split(" ").filter((word) => word.trim() !== "");

    // Create regex conditions for each word
    const regexConditions = queryWords.map((word) => ({
      name: { $regex: word, $options: "i" }, // "i" for case-insensitive
    }));

    // Search for visitors matching any of the words
    const visitors = await Visitor.find({
      $and: [{ userId: userId }, { $or: regexConditions }],
    });

    // Search for tags matching any of the words
    const tags = await ConversationTag.find({
      $and: [{ userId: userId }, { $or: regexConditions }],
    });

  // const updatedVisitors = await Promise.all(
  //   visitors.map(async (visitorDoc) => {
  //     const visitor = visitorDoc.toObject(); 
  //     const conversation = await Conversation.findOne({
  //       visitor: visitor._id,
  //     });
  //     visitor["conversation"] = conversation; 
  //     return visitor; 
  //   })
  // );

  const updatedVisitors = await Promise.all(
    visitors.map(async (visitorDoc) => {
      const visitor = visitorDoc.toObject();
      const conversation = await Conversation.findOne({
        visitor: visitor._id,
      }).lean(); // use lean() for a plain JS object
  
      if (conversation) {
        conversation["visitor"] = visitor; // Embed visitor in conversation
        return conversation;
      }
  
      return null; // Handle cases where there is no conversation
    })
  );
  
  // Optional: Filter out null values if you only care about visitors with conversations
  const filteredConversations = updatedVisitors.filter((conv) => conv !== null);
  

   // Fetch conversations for tags
   const tagConversations = await Promise.all(
    tags.map(async (tag) => {
      const conversation = await Conversation.findOne({ _id: tag.conversation });
      let visitor = await Visitor.findOne({_id:conversation.visitor});
      visitor = visitor.toObject(); 
      conversation["visitor"] = visitor; 
      return visitor;
    })
  );

  const combinedVisitors  = [
    ...filteredConversations,
    ...tagConversations.filter(Boolean), 
  ];

  // Remove duplicates by unique visitor `_id`
const uniqueVisitors = Array.from(
  new Map(combinedVisitors.map((v) => [v._id.toString(), v])).values()
);

    return uniqueVisitors;
  } catch (error) {
    throw error;
  }
};

module.exports = ConversationController;
