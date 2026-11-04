const mongoose = require("mongoose");

const blogPostSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    storeHash: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["shopify", "bigcommerce"],
      required: true,
    },
    requestId: {
      type: String,
      required: true,
      unique: true,
    },
    topic: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      required: true,
    },
    summary: {
      type: String,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
    },
    html: {
      type: String,
      required: true,
    },
    tone: {
      type: String,
      default: "friendly",
    },
    language: {
      type: String,
      default: "English",
    },
    publishNow: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ["draft", "publishing", "published", "failed"],
      default: "draft",
      index: true,
    },
    publishedUrl: {
      type: String,
      default: null,
    },
    externalId: {
      type: String,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

blogPostSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("BlogPost", blogPostSchema);
