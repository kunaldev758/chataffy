const mongoose = require("mongoose");

const blogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    content: {
      type: String,
      default: "",
      maxlength: 100000,
    },
    tags: {
      type: [String],
      default: [],
    },
    topic: {
      type: String,
      default: "",
      maxlength: 500,
    },
    platform: {
      type: String,
      enum: ["shopify"],
      default: "shopify",
    },
    status: {
      type: String,
      enum: ["draft", "published", "failed"],
      default: "draft",
    },
    shopifyBlogId: {
      type: String,
      default: null,
    },
    shopifyArticleId: {
      type: String,
      default: null,
    },
    shopifyHandle: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

blogSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model("Blog", blogSchema);
