// const Visitor = require('../models/Visitor');
// const ChatMessage = require('../models/ChatMessage');
// const ObjectId = require('mongoose').Types.ObjectId;
const ConversationTag = require("../models/ConversationTag");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");

const ConversationController = {};

// ConversationController.getAllTagsOfConversation = async (req, res) => {
//   try {
//     const conversationId = req.params.id;
//     const tags = await ConversationTag.find({conversation:{id:conversationId}});
//     res.json(tags);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to fetch tags' });
//   }
// };

//get all old conversation
ConversationController.getAllOldConversations = async (req, res) => {
  const { visitor_id } = req.params;
  try {
    let chatMessagesNotesList = [];
    if (visitor_id) {
      let conversation = await Conversation.find({
        visitor: visitor_id,
      });
      for (let conv of conversation) {
        let chatMessagesNotes = await ChatMessage.find({
          conversation_id: conv.visitor_id,
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

ConversationController.createConversation = async (visitorId) => {
  try{
    const result = await Conversation.insertOne({
      visitor: visitorId,
    });
    return result;
  }catch(err){
    throw err ;
  }
}
ConversationController.findConversation = async (visitorId) => {
  try{
    const result = await Conversation.findOne({
      visitor: visitorId,
    });
    return result;
  }catch(err){
    throw err ;
  }
}

//Add Conversation to Archive
ConversationController.AddConversationToArchive = async (req, res) => {
  const conversationId = req.params.id;
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

ConversationController.UpdateConversationStatusOpenClose = async (req, res) => {
  const conversationId = req.params.id;
  const { staus } = req.body;
  try {
    if (conversationId) {
      if (staus == "open") {
        let conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          { conversationOpenStatus: "open" }
        );
        res.status(200).json(conversation);
      } else {
        let conversation = await Conversation.findByIdAndUpdate(
          conversationId,
          { conversationOpenStatus: "close" }
        );
        res.status(200).json(conversation);
      }
    } else {
      throw error;
    }
  } catch (error) {
    res
      .status(500)
      .json({ error: "An error occurred while fetching chat messages" });
  }
};

ConversationController.searchByTagOrName = async (req, res) => {
  const query = req.body;
  const visitor = await Visitor.find({ name: query });
  const tag = await ConversationTag.find({ name: query });
  if (visitor) {
    return visitor.conversation.id;
  }
  if (tag) {
    return tag.conversationId;
  }
};

ConversationController.getTotalConversation = async (req, res) => {
  try {
    const conversationCount = await Conversation.find({}).countDocuments();
    res.status(200).json(conversationCount);
  } catch (err) {
    throw err;
  }
};

// Get a single visitor by ID
// ConversationController.getTagById = async (req, res) => {
//   const { id } = req.params;
//   try {
//     const tag = await ConversationTag.findById(id);
//     if (!tag) {
//       return res.status(404).json({ error: "Tag not found" });
//     }
//     res.json(tag);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to fetch Tag" });
//   }
// };

// Create a new tag
// const createTag = async (name, conversationId) => {
//   try {
//     if (!name || !conversationId) {
//       throw error;
//     }
//     const conversation = await Conversation.findById(conversationId);
//     const tag = new ConversationTag({ name, conversation });
//     await tag.save();
//     return tag;
//   } catch (error) {
//     throw error;
//   }
// };
// ConversationController.createTag = createTag;
// ConversationController.createTagAPI = async (req, res) => {
//   const { name, conversationId } = req.body;
//   try {
//     const tag = await createTag(name, conversationId);
//     res.status(201).json(tag);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to create tag" });
//   }
// };

// Update an existing visitor by ID
// ConversationController.updateVisitorById = async (req, res) => {
//   const { id } = req.params;
//   const { name } = req.body;
//   try {
//     const visitor = await Visitor.findByIdAndUpdate(
//       id,
//       { name },
//       { new: true }
//     );
//     if (!visitor) {
//       return res.status(404).json({ error: 'Visitor not found' });
//     }
//     res.json(visitor);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to update visitor' });
//   }
// };

// Delete an existing visitor by ID
// ConversationController.deleteTagById = async (req, res) => {
//   const { id } = req.params;
//   try {
//     const tag = await ConversationTag.findByIdAndDelete(id);
//     if (!tag) {
//       return res.status(404).json({ error: "tag not found" });
//     }
//     res.sendStatus(204);
//   } catch (error) {
//     res.status(500).json({ error: "Failed to delete tag" });
//   }
// };

module.exports = ConversationController;
