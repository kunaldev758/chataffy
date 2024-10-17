const mongoose = require('mongoose');
const {Schema} = mongoose;
const {dbName} = require('../../config/database');
const db = mongoose.connection.useDb(dbName);

const conversationSchema = new Schema({
  participants: [{
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

module.exports = db.model('Conversation', conversationSchema);
