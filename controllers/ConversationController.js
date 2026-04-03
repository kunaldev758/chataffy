const ConversationTag = require("../models/ConversationTag");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");
const ChatMessage = require("../models/ChatMessage");
const Agent = require("../models/Agent");
const emailService = require("../services/emailService");
const ConversationController = {};

//get all old conversation
ConversationController.getAllOldConversations = async (visitor_id, agentId) => {
  try {
    if (!visitor_id) return [];

    // Fetch all conversations for the visitor (open and closed)
    let conversations = await Conversation.find({
      visitor: visitor_id,
    }).sort({ createdAt: -1 });

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

//get ai only conversation
ConversationController.getAiOnlyConversation = async (agentId) => {
  try {
    const conv = await Conversation.find({
      agentId: agentId,
      aiChat: true,
      conversationOpenStatus: "open",
    }).populate('humanAgentId', 'name avatar isClient').sort({ createdAt: -1 });

    const updatedVisitors = await Promise.all(
      conv.map(async (conv) => {
        const conversation = conv.toObject();
        const visitor = await Visitor.findOne({ _id: conv.visitor });
        conversation["visitor"] = visitor;
        return conversation;
      })
    );

    return updatedVisitors;
  } catch (error) {
    console.error("Error fetching ai only conversations list:", error);
    return error;
  }
}

//get non ai only conversation
ConversationController.getNonAiOnlyConversation = async (agentId) => {
  try{
    const conv = await Conversation.find({
      agentId: agentId,
      aiChat: false,
      conversationOpenStatus: "open",
    }).populate('humanAgentId', 'name avatar isClient').sort({ createdAt: -1 });
    const updatedVisitors = await Promise.all(
      conv.map(async (conv) => {
        const conversation = conv.toObject();
        const visitor = await Visitor.findOne({ _id: conv.visitor });
        conversation["visitor"] = visitor;
        return conversation;
      })
    );
    return updatedVisitors;
  } catch (error) {
    console.error("Error fetching non ai only conversations list:", error);
    return error;
  }
}

//get good rated conversations
ConversationController.getGoodRatedConversations = async (agentId) => {
  try{
    const conv = await Conversation.find({
      agentId: agentId,
      feedback: true,
    }).populate('humanAgentId', 'name avatar isClient').sort({ createdAt: -1 });
    const updatedVisitors = await Promise.all(
      conv.map(async (conv) => {
        const conversation = conv.toObject();
        const visitor = await Visitor.findOne({ _id: conv.visitor });
        conversation["visitor"] = visitor;
        return conversation;
      })
    );
    return updatedVisitors;
  } catch (error) {
    console.error("Error fetching good rated conversations list:", error);
    return error;
  }
}

//get bad rated conversations
ConversationController.getBadRatedConversations = async (agentId) => {
  try{
    const conv = await Conversation.find({
      agentId: agentId,
      feedback: false,
    }).populate('humanAgentId', 'name avatar isClient').sort({ createdAt: -1 });
    const updatedVisitors = await Promise.all(
      conv.map(async (conv) => {
        const conversation = conv.toObject();
        const visitor = await Visitor.findOne({ _id: conv.visitor });
        conversation["visitor"] = visitor;
        return conversation;
      })
    );
    return updatedVisitors;
  } catch (error) {
    console.error("Error fetching bad rated conversations list:", error);
    return error;
  }
}


//get Open Conversation
// Excludes conversations the visitor has closed (visitorClosed: true) so that
// "Start New Chat" creates a fresh conversation even while the old one stays
// visible to agents with conversationOpenStatus: "open".
ConversationController.getOpenConversation = async (visitorId, userId, agentId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
      conversationOpenStatus: "open",
      agentId: agentId,
      visitorClosed: { $ne: true },
    });
    if(!result){
      const conversation = await ConversationController.createConversation(visitorId, userId, agentId);
      return conversation;
    }
    return result;
  } catch (err) {
    throw err;
  }
};

// Find the open conversation for an agent/client sending a message.
// Unlike getOpenConversation (used by visitors), this intentionally includes
// visitorClosed: true conversations so agents can still reply after a visitor
// has ended their side of the chat.
ConversationController.getOpenConversationForAgent = async (visitorId, userId, agentId) => {
  try {
    const result = await Conversation.findOne({
      visitor: visitorId,
      conversationOpenStatus: "open",
      agentId: agentId,
    });
    if (!result) {
      const conversation = await ConversationController.createConversation(visitorId, userId, agentId);
      return conversation;
    }
    return result;
  } catch (err) {
    throw err;
  }
};

// Mark a conversation as closed by the visitor without changing conversationOpenStatus.
// The conversation stays in the agent's open inbox; only agents can truly close it.
ConversationController.markVisitorClosed = async (conversationId) => {
  try {
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { visitorClosed: true },
    });
    return true;
  } catch (err) {
    throw err;
  }
};

ConversationController.createConversation = async (visitorId, userId, agentId) => {
  try {
    const result = await Conversation.create({
      visitor: visitorId,
      userId: userId,
      agentId: agentId
    });
    return result;
  } catch (err) {
    throw err;
  }
};

ConversationController.updateFeedback = async (conversationId, feedback, comment) => {
  try {
    const updateData = { feedback: feedback };
    if (comment !== undefined && comment !== null) {
      updateData.comment = comment;
    }
    await Conversation.findByIdAndUpdate(conversationId, updateData);
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
  status,
  closedBy
) => {
  try {
    if (conversationId) {
      if (status == "open") {
        await Conversation.findByIdAndUpdate(conversationId, {
          $set: { conversationOpenStatus: "open" },
          $unset: { closedBy: "" },
        });
        return true;
      } else {
        const $set = { conversationOpenStatus: "close" };
        if (closedBy != null && String(closedBy).trim() !== "") {
          $set.closedBy = String(closedBy).trim();
        }
        await Conversation.findByIdAndUpdate(conversationId, { $set });
        return true;
      }
    } else {
      throw error;
    }
  } catch (error) {
    throw error;
  }
};

ConversationController.searchByTagOrName = async (query, userId, agentId) => {
  try {
    // Split the query into individual words
    const queryWords = query.split(" ").filter((word) => word.trim() !== "");

    // Create regex conditions for each word
    const regexConditions = queryWords.map((word) => ({
      name: { $regex: word, $options: "i" }, // "i" for case-insensitive
    }));

    // Search for visitors matching any of the words
    const visitors = await Visitor.find({
      $and: [{ userId: userId }, { $or: regexConditions }, { agentId: agentId }],
    });

    // Search for tags matching any of the words
    const tags = await ConversationTag.find({
      $and: [{ userId: userId }, { $or: regexConditions }, { agentId: agentId }],
    });

  const updatedVisitors = await Promise.all(
    visitors.map(async (visitorDoc) => {
      const visitor = visitorDoc.toObject();
      const conversation = await Conversation.findOne({
        visitor: visitor._id,
        is_started:true,
        agentId: agentId
      }).populate('humanAgentId', 'name avatar isClient').lean(); // use lean() for a plain JS object
  
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
      const conversation = await Conversation.findOne({ _id: tag.conversation, is_started:true, agentId: agentId }).populate('agentId', 'name avatar isClient').lean();
  
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

ConversationController.getFilteredConversations = async (req, res) => {
  try {
    const { status, rating, handledBy } = req.body;
    const userId = req.userId;
    const agentId = req.body.agentId || req.agentId;

    const query = { userId };
    if (agentId) query.agentId = agentId;

    if (status && status !== "all") {
      query.conversationOpenStatus = status;
    }
    if (rating === "good") {
      query.feedback = true;
    } else if (rating === "bad") {
      query.feedback = false;
    }
    if (handledBy === "ai") {
      query.aiChat = true;
    }

    const conv = await Conversation.find(query)
      .populate("humanAgentId", "name avatar isClient")
      .sort({ createdAt: -1 });

    const updatedVisitors = await Promise.all(
      conv.map(async (conv) => {
        const conversation = conv.toObject();
        const visitor = await Visitor.findOne({ _id: conv.visitor });
        conversation["visitor"] = visitor;
        return conversation;
      })
    );

    res.json({ success: true, conversations: updatedVisitors });
  } catch (error) {
    console.error("Error fetching filtered conversations:", error);
    res.status(500).json({ success: false, error: error.message });
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
