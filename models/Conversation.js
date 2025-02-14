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
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const Converation = mongoose.model("Conversation", conversationSchema);
module.exports = Converation;
