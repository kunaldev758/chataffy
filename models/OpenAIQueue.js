const mongoose = require('mongoose');
const {Schema} = mongoose;

const openAIQueueSchema = new Schema({
  queue_type: {
    type: String,
    required: true,
    enum: ["chat", "pagetosnippets"]
  },
  controller_function_name: {
    type: String,
    required: true,
    enum: ["respondChat","respondLargeChat"]
  },
  visitor_id: {
    type: Schema.Types.ObjectId,
    // required: true,
  },
  chat_message_id: {
    type: Schema.Types.ObjectId,
    // required: true,
  },
  messages: {
    type: [Object],
    required: true,
  },
  tools: {
    type: [Object],
  },
  tool_choice: {
    type: Schema.Types.Mixed,
  },
  temperature: {
    type: Number,
    required: true,
  },
  frequency_penalty: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ["pending", "progress", "resolved", "rejected"]
  },
  functions: {
    type: [Object],
  },
  function_call: {
    type: Schema.Types.Mixed,
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

const OpenAIQueue= mongoose.model('OpenAIQueue', openAIQueueSchema);
module.exports = OpenAIQueue;
