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
    conversationOpenStatus: {
      type: String,
      enum: ["open", "close"],
      default: "open",
      required: true,
    },
    newMessage: { type: Number, default: 0 },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    aiChat: { type: Boolean, default: true },
    feedback: { type: Boolean },
    is_started:{type: Boolean, default: false },
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
