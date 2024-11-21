const mongoose = require("mongoose");
const { Schema } = mongoose;

const conversationSchema = new mongoose.Schema(
  {
    visitor: {
      type: String,
      required: true,
    },
    conversationOpenStatus: {
      type: String,
      enum: ["open", "close"],
      default: "open",
      required: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    aiChat: { type: Boolean, default: true },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const Converation = mongoose.model("Conversation", conversationSchema);
module.exports = Converation;
