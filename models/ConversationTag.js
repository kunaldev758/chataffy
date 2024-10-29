const mongoose = require('mongoose');
const {Schema} = mongoose;
// const {dbName} = require('../../config/database');
// const db = mongoose.connection.useDb(dbName);

const conversationTagSchema = new mongoose.Schema({
  tagName: [{
    type: String,
    required: true,
  }],
  conversation:{ type: mongoose.Schema.Types.ObjectId, ref: "Conversation" },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
},
{ timestamps: true }
);

const ConversationTag = mongoose.model('ConversationTag', conversationTagSchema);
module.exports = ConversationTag ;
