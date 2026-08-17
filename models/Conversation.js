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
    ragState: {
      type: {
        lastIntent: { type: String, default: null },
        topic: { type: String, default: null },
        entities: {
          product: { type: String, default: null },
          sizes: { type: [String], default: [] },
          collection: { type: String, default: null },
          productTerms: { type: [String], default: [] },
        },
        lastStandaloneQuery: { type: String, default: null },
        awaiting: { type: String, default: null },
        turn: { type: Number, default: 0 },
        updatedAt: { type: Date, default: null },
      },
      default: null,
    },
    recallState: {
      type: {
        userQuestionIndex: { type: Number, default: null },
        anchorUserTurnCount: { type: Number, default: null },
        updatedAt: { type: Date, default: null },
      },
      default: null,
    },
  },
  { timestamps: true }
);

const Converation = mongoose.model("Conversation", conversationSchema);
module.exports = Converation;
