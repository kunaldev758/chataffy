const mongoose = require("mongoose");

const wordPressConnectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    platform: {
      type: String,
      default: "wordpress",
      enum: ["wordpress"],
    },
    siteUrl: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    /** AES-GCM encrypted Application Password — never return to frontend */
    applicationPassword: {
      type: String,
      required: true,
    },
    isConnected: {
      type: Boolean,
      default: false,
    },
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
    displayName: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

wordPressConnectionSchema.index({ userId: 1 }, { unique: true });

module.exports = mongoose.model("WordPressConnection", wordPressConnectionSchema);
