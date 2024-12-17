const ConversationTag = require('../models/ConversationTag');
const Conversation = require('../models/Conversation');


const ConversationTagController = {};


ConversationTagController.getAllTagsOfConversation = async (conversationId) => {
  try {
    const tags = await ConversationTag.find({ conversation: conversationId.conversationId });
    return tags;
  } catch (error) {
    return error;
  }
};

// Get a single visitor by ID
ConversationTagController.getTagById = async (req, res) => {
  const { id } = req.params;
  try {
    const tag = await ConversationTag.findById(id);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    res.json(tag);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Tag' });
  }
};

// Create a new tag
const createTag = async (data) => {
    try {
      const {name,conversationId} = data;
      if(!name || !conversationId) {
        throw error;
      }
      const conversation = await Conversation.findById(conversationId)
      const tag = new ConversationTag({  name,conversation });
      await tag.save();
      const tags = await ConversationTag.find({ conversation:{_id:conversation._id} });
    return tags;
      // return tag;
    } catch(error) {
      throw error;
    }
  };
  ConversationTagController.createTag = createTag;
ConversationTagController.createTagAPI = async (req, res) => {
  const { name,conversationId } = req.body.basicInfo;
  try {
    const tag = await createTag(name,conversationId);
    res.status(201).json(tag);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tag' });
  }
};

// Delete an existing visitor by ID
ConversationTagController.deleteTagById = async (id) => {
  try {
    const tag = await ConversationTag.findByIdAndDelete(id);
    if (!tag) {
      return res.status(404).json({ error: 'tag not found' });
    }
   return tag;
  } catch (error) {
    return error;
  }
};

module.exports = ConversationTagController;
