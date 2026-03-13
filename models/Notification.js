const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Agent",
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Conversation",
    },
    visitorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Visitor",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    message: {
      type: String,
      default: "Visitor requested to connect to an agent",
    },
    type: {
      type: String,
      enum: ["agent-connection-request"],
      default: "agent-connection-request",
    },
    isSeen: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
