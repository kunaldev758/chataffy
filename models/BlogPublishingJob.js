const mongoose = require("mongoose");

const blogPublishingJobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Store",
      index: true,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    generatedBlog: {
      title: { type: String, default: "" },
      content: { type: String, default: "" },
      summary: { type: String, default: "" },
      tags: { type: [String], default: [] },
      handle: { type: String, default: "" },
    },
    shopifyBlogId: { type: String, default: null },
    shopifyBlogHandle: { type: String, default: null },
    shopifyArticleId: { type: String, default: null },
    shopifyArticleHandle: { type: String, default: null },
    shopifyArticleUrl: { type: String, default: null },
    shopifyIsPublished: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["generating", "queued", "publishing", "published", "failed"],
      default: "generating",
      index: true,
    },
    n8nExecutionId: { type: String, default: null },
    errorMessage: { type: String, default: null },
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

blogPublishingJobSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model("BlogPublishingJob", blogPublishingJobSchema);
