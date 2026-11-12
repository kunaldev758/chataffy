const mongoose = require("mongoose");

const blogPostSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    tone: {
      type: String,
      default: "Professional",
    },
    language: {
      type: String,
      default: "English",
    },
    length: {
      type: String,
      default: "1500 words",
    },
    title: {
      type: String,
      default: "",
    },
    content: {
      type: String,
      default: "",
    },
    excerpt: {
      type: String,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
    },
    metaTitle: {
      type: String,
      default: "",
    },
    metaDescription: {
      type: String,
      default: "",
    },
    /** draft | generated | published | failed */
    status: {
      type: String,
      enum: ["draft", "generated", "published", "failed"],
      default: "draft",
    },
    wordpressPostId: {
      type: Number,
      default: null,
    },
    wordpressPostUrl: {
      type: String,
      default: "",
    },
    wordpressStatus: {
      type: String,
      default: "",
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    publishError: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

blogPostSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("BlogPost", blogPostSchema);
