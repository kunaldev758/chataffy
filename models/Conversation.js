const mongoose = require('mongoose');
const {Schema} = mongoose;
// const {dbName} = require('../../config/database');
// const db = mongoose.connection.useDb(dbName);

const conversationSchema = new mongoose.Schema({
  participants: [{
    type: String,
    required: true,
  }],
  conversationOpenStatus:{
    type: String,
    enum: ['open','close'],
    default:'open',
    required: true,
  },
  isArchived:{
    type: Boolean,
    default:false,
  },
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

const Converation = mongoose.model('Conversation', conversationSchema);
module.exports =  Converation;