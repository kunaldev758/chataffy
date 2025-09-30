const ConversationTag = require("../models/ConversationTag");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");
const ChatMessage = require("../models/ChatMessage");
const emailService = require("../services/emailService");
const ConversationController = {};

//get all old conversation
ConversationController.getAllOldConversations = async (visitor_id, agentId) => {
  try {
    if (!visitor_id) return [];

    // Fetch closed conversations for the visitor
    let conversations = await Conversation.find({
      visitor: visitor_id,
      conversationOpenStatus: "close",
      // agentId: agentId
    });

    // For each conversation, get the last message and add it to the `message` field
    const updatedConversations = await Promise.all(
      conversations.map(async (conv) => {
        const lastMessage = await ChatMessage.findOne({ conversation_id: conv._id })
          .sort({ createdAt: -1 });

        return {
          ...conv.toObject(),
          message: lastMessage?.message || null, // Add message field
        };
      })
    );

    return updatedConversations;
  } catch (error) {
    return error;
  }
};


//get Open Conversation
ConversationController.getOpenConversation = async (visitorId, userId, agentId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
      conversationOpenStatus: "open",
      // agentId: agentId
    });
    if(!result){
      // const conversation = await ConversationController.createConversation(visitorId, userId, agentId);
      const conversation = await ConversationController.createConversation(visitorId, userId);
      return conversation;
    }
    return result;
  } catch (err) {
    throw err;
  }
};

ConversationController.createConversation = async (visitorId, userId, agentId) => {
  try {
    const result = await Conversation.create({
      visitor: visitorId,
      userId: userId,
      // agentId: agentId
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

  const updatedVisitors = await Promise.all(
    visitors.map(async (visitorDoc) => {
      const visitor = visitorDoc.toObject();
      const conversation = await Conversation.findOne({
        visitor: visitor._id,
        is_started:true,
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
      // const visitor = visitorDoc.toObject();
      const conversation = await Conversation.findOne({ _id: tag.conversation, is_started:true, }).lean();
  
      if (conversation) {
        const visitor = await Visitor.findOne({ _id: conversation.visitor }).lean();
        conversation["visitor"] = visitor; // Embed visitor in conversation
        return conversation;
      }
  
      return null; // Handle cases where there is no conversation
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

// Add to ConversationController
ConversationController.getConversationStats = async (timeframe = 'today') => {
  try {
    const now = new Date();
    let startDate;
    
    switch(timeframe) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      default:
        startDate = new Date(0); // All time
    }

    const stats = await Conversation.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          aiChats: { 
            $sum: { $cond: [{ $eq: ["$aiChat", true] }, 1, 0] }
          },
          humanChats: { 
            $sum: { $cond: [{ $eq: ["$aiChat", false] }, 1, 0] }
          },
          openChats: { 
            $sum: { $cond: [{ $eq: ["$conversationOpenStatus", "open"] }, 1, 0] }
          }
        }
      }
    ]);

    return stats[0] || { total: 0, aiChats: 0, humanChats: 0, openChats: 0 };
  } catch (error) {
    throw error;
  }
};

ConversationController.sendEmailForOfflineChatController = async (req, res) => {
  try {
    const visitorDetails = req.body.visitorDetails;
    const message = req.body.message;
    const userId = req.body.userId;
    await emailService.sendEmailForOfflineChat(visitorDetails.email,visitorDetails.location,visitorDetails.ip,visitorDetails.reason, message,userId);
    res.json({ success: true, message: "Email sent successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to send email" });
    throw error;
  }
}

module.exports = ConversationController;
