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
// Get all chat messages
const getAllChatMessages = async (visitor_id) => {
  try {
    let chatMessages;
    if (visitor_id) {
      const conversation_id = await Conversation.findOne({
        visitor: visitor_id,
        conversationOpenStatus: "open",
      });
      chatMessages = await ChatMessage.find({ conversation_id });
    } else {
      throw new error();
    }
    return chatMessages;
  } catch (error) {
    throw error;
  }
};
ChatMessageController.getAllChatMessages = getAllChatMessages;
ChatMessageController.getAllChatMessagesAPI = async (req, res) => {
  try {
    const chatMessages = await getAllChatMessages(req.body.id); //conversationId
    res.json({ chatMessages: chatMessages, conversationOpenStatus: "open" });
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
      chatMessages = await ChatMessage.find({ conversation_id });
    } else {
      throw new error();
    }
    res.json({ chatMessages: chatMessages, conversationOpenStatus: "close" });
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
  sources = undefined
) => {
  try {
    const chatMessage = new ChatMessage({
      sender,
      sender_type,
      message,
      conversation_id,
      infoSources: sources,
      userId,
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
  userId
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
