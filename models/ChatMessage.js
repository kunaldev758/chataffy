const mongoose = require('mongoose');
const {Schema} = mongoose;

const chatMessageSchema = new Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true , ref: 'User'},
  sender: {
    type: String,
    // required: true,
  },
  sender_type: {
    type: String,
    enum: ['visitor', 'client','ai', 'system', 'humanAgent'],
    required: true,
  },
  is_note:{
    type:String,
    default:false
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
    ref: 'Conversation',
    required: true,
  },
  humanAgentId: {
    type: Schema.Types.ObjectId,
    ref: 'HumanAgent',
    required: false,
  },
  agentId: {
    type: Schema.Types.ObjectId,
    ref: 'Agent',
    required: false,
  },
  replyTo: {
    type: Schema.Types.ObjectId,
    ref: 'ChatMessage',
    required: false,
  },
},
{ timestamps: true }
);

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
module.exports = ChatMessage;
