const mongoose = require('mongoose');
const {Schema} = mongoose;
const {dbName} = require('../../config/database');
const db = mongoose.connection.useDb(dbName);

const conversationTagSchema = new Schema({
  tagName: [{
    type: String,
    required: true,
  }],
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

module.exports = db.model('ConversationTag', conversationTagSchema);
