const mongoose = require("mongoose");
const { Schema } = mongoose;

const conversationSchema = new mongoose.Schema(
  {
    visitor: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: "Agent",
    },
    humanAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: "HumanAgent",
    },
    conversationOpenStatus: {
      type: String,
      enum: ["open", "close"],
      default: "open",
      required: true,
    },
    closedBy: {
      type: String,
      default: null,
    },
    newMessage: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    aiChat: { type: Boolean, default: true },
    feedback: { type: Boolean },
    comment: { type: String },
    is_started:{type: Boolean, default: false },
    visitorClosed: { type: Boolean, default: false },
    transferredAt: {
      type: Date,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const Converation = mongoose.model("Conversation", conversationSchema);
module.exports = Converation;
