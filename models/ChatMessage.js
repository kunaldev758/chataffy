const mongoose = require('mongoose');
const {Schema} = mongoose;

const chatMessageSchema = new Schema({
  sender: {
    type: String,
    required: true,
  },
  sender_type: {
    type: String,
    enum: ['visitor', 'agent', 'bot', 'bot-error', 'system'],
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  infoSources: {
    type: [String],
  },
  conversation_id: {
    type: Schema.Types.ObjectId,
    ref: 'Visitor',
    required: true,
  }
},
{ timestamps: true }
);

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
module.exports = ChatMessage;
