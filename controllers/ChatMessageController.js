const ChatMessage = require("../models/ChatMessage");
const Conversation = require("../models/Conversation");

const ChatMessageController = {};

// Get all chat messages
ChatMessageController.getRecentChatMessages = async (conversation_id) => {
  try {
    let chatMessages;
    if (conversation_id) {
      chatMessages = await ChatMessage.find({ conversation_id })
        .sort({ createdAt: 1 })
        .limit(5);
    } else {
      return [];
    }
    return chatMessages;
  } catch (error) {
    throw error;
  }
};
const fetchChatMessagesByConversationId = async (conversation_id) => {
  if (!conversation_id) return [];
  return ChatMessage.find({ conversation_id })
    .populate("humanAgentId", "name avatar isClient")
    .populate({
      path: "replyTo",
      select: "sender message createdAt sender_type humanAgentId",
      populate: { path: "humanAgentId", select: "name isClient" },
    })
    .lean();
};

// Get all chat messages (optionally scoped by agentId for multi-agent support)
const getAllChatMessages = async (visitor_id, agentId) => {
  try {
    if (!visitor_id) {
      throw new Error("visitor_id is required");
    }
    const query = { visitor: visitor_id, conversationOpenStatus: "open" };
    if (agentId != null) query.agentId = agentId;
    const conversation = await Conversation.findOne(query);
    return fetchChatMessagesByConversationId(conversation?._id);
  } catch (error) {
    throw error;
  }
};
ChatMessageController.getAllChatMessages = getAllChatMessages;
ChatMessageController.getAllChatMessagesAPI = async (req, res) => {
  try {
    const conversationId = req.body.id;
    if (!conversationId) {
      return res.status(400).json({ error: "conversation id is required" });
    }
    const conversationDoc = await Conversation.findOne({
      _id: conversationId,
    }).lean();
    const chatMessages = await fetchChatMessagesByConversationId(
      conversationDoc?._id
    );
    const conversationData = conversationDoc
      ? {
          feedback: conversationDoc.feedback,
          comment: conversationDoc.comment,
        }
      : null;
    res.json({
      chatMessages,
      conversationOpenStatus: conversationDoc?.conversationOpenStatus ?? null,
      conversationFeedback: conversationData,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch chat messages" });
  }
};

// Get all chat messages
ChatMessageController.getAllOldChatMessages = async (req, res) => {
  try {
    let conversation_id = req.body.id.conversationId;
    let chatMessages;
    if (conversation_id) {
      chatMessages = await ChatMessage.find({ conversation_id })
        .populate('humanAgentId', 'name avatar isClient')
        .populate({ path: 'replyTo', select: 'sender message createdAt sender_type humanAgentId', populate: { path: 'humanAgentId', select: 'name isClient' } })
        .lean();
      
      // Get conversation feedback data
      const Conversation = require("../models/Conversation");
      const conversation = await Conversation.findById(conversation_id).lean();
      let conversationData = null;
      if (conversation) {
        conversationData = {
          feedback: conversation.feedback,
          comment: conversation.comment
        };
      }

      res.json({
        chatMessages: chatMessages,
        conversationOpenStatus: conversation?.conversationOpenStatus ?? null,
        conversationFeedback: conversationData,
      });
    } else {
      throw new error();
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch chat messages" });
  }
};

// Create a new chat message
ChatMessageController.createChatMessage = async (
  conversation_id,
  sender,
  sender_type,
  message,
  userId,
  agentId,
  sources = undefined,
  humanAgentId = undefined,
  replyTo = undefined
) => {
  try {
    const chatMessage = new ChatMessage({
      sender,
      sender_type,
      message,
      conversation_id,
      infoSources: sources,
      userId,
      agentId,
      humanAgentId: (sender_type === 'humanAgent' || sender_type === 'client') ? humanAgentId : undefined,
      replyTo: replyTo || undefined,
    });
    await chatMessage.save();
    return chatMessage;
  } catch (error) {
    throw error;
  }
};

// Update an existing chat message by ID
ChatMessageController.updateChatMessageById = async (req, res) => {
  const { id } = req.params;
  const { sender, sender_type, message, conversation_id } = req.body;
  try {
    const chatMessage = await ChatMessage.findByIdAndUpdate(
      id,
      { sender, sender_type, message, conversation_id },
      { new: true }
    );
    if (!chatMessage) {
      return res.status(404).json({ error: "Chat message not found" });
    }
    res.json(chatMessage);
  } catch (error) {
    res.status(500).json({ error: "Failed to update chat message" });
  }
};

//mark conversation as note
ChatMessageController.addNoteToChat = async (
  sender,
  sender_type,
  message,
  conversation_id,
  userId,
  agentId,
  humanAgentId,
  replyTo = undefined,
) => {
  try {
    const chatMessage = new ChatMessage({
      sender,
      sender_type,
      message,
      conversation_id,
      infoSources: undefined,
      is_note: true,
      userId,
      agentId,
      humanAgentId: (sender_type === 'humanAgent' || sender_type === 'client') ? humanAgentId : undefined,
      replyTo: replyTo || undefined,
    });
    await chatMessage.save();
    return chatMessage;
  } catch (error) {
    res.status(500).json({ error: "Failed to create chat message" });
  }
};

//get all notes of conversation
ChatMessageController.getAllChatNotesMessages = async (conversationId) => {
  try {
    let chatMessagesNotes;
    if (conversationId) {
      chatMessagesNotes = await ChatMessage.find({
        conversation_id: conversationId,
        is_note: "true",
      });
    }
    return chatMessagesNotes;
  } catch (error) {
    return error;
  }
};

// Delete an existing chat message by ID
ChatMessageController.deleteChatMessageById = async (req, res) => {
  const { id } = req.params;
  try {
    const chatMessage = await ChatMessage.findByIdAndDelete(id);
    if (!chatMessage) {
      return res.status(404).json({ error: "Chat message not found" });
    }
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: "Failed to delete chat message" });
  }
};

module.exports = ChatMessageController;
