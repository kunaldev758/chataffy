const BlogPublishingJob = require("../models/BlogPublishingJob");
const {
  publicJob,
  listHome,
  getOwnedJob,
  startGenerateAndPublish,
  publishJob,
  applyCallback,
  isObjectId,
} = require("../services/blogPublishingService");
const { listBlogCollections } = require("../services/ShopifyContentService");
const { getValidShopifyAccessToken } = require("../routes/shopify");
const Store = require("../models/Store");

function sendError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    status: false,
    status_code: statusCode,
    code: error.code || "BLOG_PUBLISH_ERROR",
    message: error.message || fallback,
  });
}

exports.getPublisherHome = async (req, res) => {
  try {
    const home = await listHome(req.body.userId);
    return res.json({ status: true, status_code: 200, ...home });
  } catch (error) {
    console.error("[BlogPublisher] home failed:", error.message);
    return sendError(res, error, "Could not load the blog publisher");
  }
};

exports.generateAndPublish = async (req, res) => {
  try {
    const job = await startGenerateAndPublish({
      userId: req.body.userId,
      topic: req.body.topic,
      storeId: req.body.storeId,
      shopifyBlogId: req.body.shopifyBlogId,
      shopifyBlogTitle: req.body.shopifyBlogTitle,
    });
    const failed = job.status === "failed";
    return res.status(failed ? 502 : 200).json({
      status: !failed,
      status_code: failed ? 502 : 200,
      message: failed ? job.errorMessage : "Publishing started",
      job: publicJob(job),
    });
  } catch (error) {
    console.error("[BlogPublisher] generate-publish failed:", error.message);
    return sendError(res, error, "Could not start publishing");
  }
};

exports.getJob = async (req, res) => {
  try {
    const job = await getOwnedJob(req.body.userId, req.params.id);
    if (!job) {
      return res.status(404).json({
        status: false,
        status_code: 404,
        message: "Publishing job not found.",
      });
    }
    return res.json({ status: true, status_code: 200, job: publicJob(job) });
  } catch (error) {
    console.error("[BlogPublisher] job status failed:", error.message);
    return sendError(res, error, "Could not load publishing status");
  }
};

exports.listShopifyBlogs = async (req, res) => {
  try {
    const storeId = req.query.storeId;
    if (!isObjectId(storeId)) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Select a Shopify store.",
      });
    }
    const store = await Store.findOne({
      _id: storeId,
      userId: req.body.userId,
      platform: "shopify",
      status: { $ne: "uninstalled" },
    });
    if (!store) {
      return res.status(403).json({
        status: false,
        status_code: 403,
        message: "That Shopify store is not connected to this account.",
      });
    }
    const accessToken = await getValidShopifyAccessToken(store);
    const blogs = await listBlogCollections(store.storeHash, accessToken);
    return res.json({
      status: true,
      status_code: 200,
      blogs,
      hasWriteContent: String(store.scope || "").includes("write_content"),
    });
  } catch (error) {
    console.error("[BlogPublisher] shopify blogs failed:", error.message);
    return sendError(res, error, "Could not load Shopify blogs");
  }
};

exports.getInternalJob = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Job id is invalid.",
      });
    }
    const job = await BlogPublishingJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({
        status: false,
        status_code: 404,
        message: "Publishing job not found.",
      });
    }
    return res.json({ status: true, status_code: 200, job: publicJob(job) });
  } catch (error) {
    console.error("[BlogPublisher] internal get failed:", error.message);
    return sendError(res, error, "Could not load the publishing job");
  }
};

exports.publishInternal = async (req, res) => {
  try {
    const job = await publishJob(req.body.jobId);
    return res.json({
      status: true,
      status_code: 200,
      message: job.shopifyIsPublished
        ? "Published to Shopify."
        : "Saved on Shopify as a draft.",
      job: publicJob(job),
    });
  } catch (error) {
    console.error("[BlogPublisher] internal publish failed:", error.message);
    return sendError(res, error, "Could not publish the blog");
  }
};

exports.callbackInternal = async (req, res) => {
  try {
    const job = await applyCallback({
      jobId: req.body.jobId,
      n8nExecutionId: req.body.n8nExecutionId,
      status: req.body.status,
      errorMessage: req.body.errorMessage,
    });
    return res.json({ status: true, status_code: 200, job: publicJob(job) });
  } catch (error) {
    console.error("[BlogPublisher] callback failed:", error.message);
    return sendError(res, error, "Could not update the publishing job");
  }
};
