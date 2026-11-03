const crypto = require("crypto");
const axios = require("axios");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const BlogPublishingJob = require("../models/BlogPublishingJob");
const Store = require("../models/Store");
const { getValidShopifyAccessToken } = require("../routes/shopify");
const {
  createArticle,
  listBlogCollections,
} = require("./ShopifyContentService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BLOG_MODEL = process.env.OPENAI_CHAT_MODEL_BRIEF || "gpt-4.1-mini";

function secretsMatch(provided, expected) {
  const left = Buffer.from(String(provided || ""));
  const right = Buffer.from(String(expected || ""));
  if (!expected || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireInternalSecret(req, res, next) {
  const header = req.header("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!secretsMatch(token, process.env.N8N_INTERNAL_API_SECRET)) {
    return res.status(401).json({
      status: false,
      status_code: 401,
      message: "Internal publishing authentication failed.",
    });
  }
  return next();
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function scopeNames(scope) {
  return String(scope || "")
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function hasWriteContent(scope) {
  return scopeNames(scope).includes("write_content");
}

function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const unique = [];
  for (const tag of list) {
    const clean = String(tag || "").trim().slice(0, 50);
    if (!clean || unique.includes(clean)) continue;
    unique.push(clean);
    if (unique.length >= 8) break;
  }
  return unique;
}

function publishImmediately() {
  return String(process.env.BLOG_PUBLISH_IMMEDIATELY || "").toLowerCase() === "true";
}

function publicJob(job) {
  const blog = job.generatedBlog || {};
  return {
    _id: job._id,
    storeId: job.storeId,
    topic: job.topic,
    generatedBlog: {
      title: blog.title || "",
      content: blog.content || "",
      summary: blog.summary || "",
      tags: blog.tags || [],
      handle: blog.handle || "",
    },
    shopifyBlogId: job.shopifyBlogId || null,
    shopifyArticleId: job.shopifyArticleId || null,
    shopifyArticleUrl: job.shopifyArticleUrl || null,
    shopifyIsPublished: Boolean(job.shopifyIsPublished),
    status: job.status,
    errorMessage: job.errorMessage || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function publicStore(store) {
  return {
    _id: store._id,
    name: store.name,
    storeHash: store.storeHash,
    hasWriteContent: hasWriteContent(store.scope),
    defaultShopifyBlogId: store.defaultShopifyBlogId || null,
    defaultShopifyBlogTitle: store.defaultShopifyBlogTitle || null,
  };
}

function articleUrl(store, blogHandle, articleHandle) {
  if (!articleHandle) return null;
  const base = String(store.storeUrl || `https://${store.storeHash}`).replace(/\/$/, "");
  return `${base}/blogs/${blogHandle || "news"}/${articleHandle}`;
}

async function merchantStore(userId, storeId) {
  if (!isObjectId(storeId)) return null;
  return Store.findOne({
    _id: storeId,
    userId,
    platform: "shopify",
    status: { $ne: "uninstalled" },
  });
}

async function generateSeoBlog(topic) {
  const completion = await openai.chat.completions.create({
    model: BLOG_MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You write original SEO blog articles for a Shopify store. Return JSON with keys title, handle (lowercase hyphenated slug), summary (one sentence under 160 characters), content (HTML using only h2, h3, p, ul, ol, li, strong, em, a), and tags (array of 3 to 6 short strings). Do not include script, style, or iframe tags. Do not mention that you are an AI.",
      },
      {
        role: "user",
        content: `Topic: ${topic}`,
      },
    ],
  });
  let parsed;
  try {
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
  } catch {
    const error = new Error("AI returned an unreadable article. Try again.");
    error.statusCode = 502;
    throw error;
  }
  const title = String(parsed.title || topic).trim().slice(0, 255);
  const content = sanitizeHtml(parsed.content || parsed.body || "").slice(0, 100000);
  if (!title || content.length < 40) {
    const error = new Error("AI did not return a usable title and article.");
    error.statusCode = 502;
    throw error;
  }
  return {
    title,
    content,
    summary: String(parsed.summary || "").trim().slice(0, 300),
    tags: normalizeTags(parsed.tags),
    handle: slugify(parsed.handle || title),
  };
}

async function triggerN8n(jobId) {
  const url = String(process.env.N8N_WEBHOOK_URL || "").trim();
  if (!url) {
    const error = new Error(
      "n8n webhook is not configured. Set N8N_WEBHOOK_URL on the Chataffy backend.",
    );
    error.statusCode = 503;
    error.code = "N8N_NOT_CONFIGURED";
    throw error;
  }
  const headers = { "Content-Type": "application/json" };
  if (process.env.N8N_WEBHOOK_SECRET) {
    headers.Authorization = `Bearer ${process.env.N8N_WEBHOOK_SECRET}`;
  }
  await axios.post(
    url,
    { jobId: String(jobId), event: "blog.publish.requested" },
    { headers, timeout: 15000 },
  );
}

async function listHome(userId) {
  const [jobs, stores] = await Promise.all([
    BlogPublishingJob.find({ userId }).sort({ updatedAt: -1 }).limit(20).lean(),
    Store.find({
      userId,
      platform: "shopify",
      status: { $ne: "uninstalled" },
      accessToken: { $nin: [null, ""] },
    })
      .select(
        "name storeHash status scope defaultShopifyBlogId defaultShopifyBlogTitle",
      )
      .sort({ name: 1 })
      .lean(),
  ]);
  return {
    jobs: jobs.map(publicJob),
    stores: stores.map(publicStore),
  };
}

async function getOwnedJob(userId, jobId) {
  if (!isObjectId(jobId)) return null;
  return BlogPublishingJob.findOne({ _id: jobId, userId });
}

async function startGenerateAndPublish({ userId, topic, storeId, shopifyBlogId, shopifyBlogTitle }) {
  const cleanTopic = String(topic || "").trim().slice(0, 500);
  if (cleanTopic.length < 3) {
    const error = new Error("Add a blog topic of at least 3 characters.");
    error.statusCode = 400;
    throw error;
  }
  const store = await merchantStore(userId, storeId);
  if (!store) {
    const error = new Error("That Shopify store is not connected to this account.");
    error.statusCode = 403;
    throw error;
  }
  if (!hasWriteContent(store.scope)) {
    const error = new Error(
      "This store is missing write_content. Reopen Chataffy in Shopify Admin and approve blog write access.",
    );
    error.statusCode = 403;
    error.code = "SHOPIFY_SCOPE_REQUIRED";
    throw error;
  }
  const destinationId = String(shopifyBlogId || store.defaultShopifyBlogId || "").trim();
  if (!destinationId) {
    const error = new Error("Select the Shopify blog this article should go in.");
    error.statusCode = 400;
    error.code = "BLOG_REQUIRED";
    throw error;
  }

  if (destinationId !== store.defaultShopifyBlogId) {
    await Store.updateOne(
      { _id: store._id, userId },
      {
        $set: {
          defaultShopifyBlogId: destinationId,
          defaultShopifyBlogTitle: String(shopifyBlogTitle || "").slice(0, 200),
        },
      },
    );
  }

  let job = await BlogPublishingJob.create({
    userId,
    storeId: store._id,
    topic: cleanTopic,
    shopifyBlogId: destinationId,
    status: "generating",
  });

  try {
    const generated = await generateSeoBlog(cleanTopic);
    job.generatedBlog = generated;
    job.status = "queued";
    job.errorMessage = null;
    await job.save();
  } catch (error) {
    job.status = "failed";
    job.errorMessage = error.message || "Blog generation failed";
    await job.save();
    return job;
  }

  try {
    await triggerN8n(job._id);
  } catch (error) {
    job.status = "failed";
    job.errorMessage = error.message || "Could not start the n8n workflow";
    await job.save();
  }
  return job;
}

async function publishJob(jobId) {
  if (!isObjectId(jobId)) {
    const error = new Error("Job id is invalid.");
    error.statusCode = 400;
    throw error;
  }

  const existing = await BlogPublishingJob.findById(jobId);
  if (!existing) {
    const error = new Error("Publishing job not found.");
    error.statusCode = 404;
    throw error;
  }
  if (existing.status === "published" && existing.shopifyArticleId) {
    return existing;
  }
  if (existing.status === "publishing") {
    const error = new Error("This job is already being published.");
    error.statusCode = 409;
    error.code = "JOB_LOCKED";
    throw error;
  }

  const locked = await BlogPublishingJob.findOneAndUpdate(
    {
      _id: jobId,
      status: { $in: ["queued", "failed"] },
      shopifyArticleId: null,
    },
    { $set: { status: "publishing", lockedAt: new Date(), errorMessage: null } },
    { new: true },
  );
  if (!locked) {
    const again = await BlogPublishingJob.findById(jobId);
    if (again?.status === "published" && again.shopifyArticleId) return again;
    const error = new Error("This job cannot be published in its current state.");
    error.statusCode = 409;
    error.code = "JOB_LOCKED";
    throw error;
  }

  try {
    const store = await Store.findOne({
      _id: locked.storeId,
      userId: locked.userId,
      platform: "shopify",
      status: { $ne: "uninstalled" },
    });
    if (!store) {
      const error = new Error("The Shopify store for this job is no longer connected.");
      error.statusCode = 403;
      throw error;
    }
    if (!locked.shopifyBlogId) {
      const error = new Error("This job has no Shopify blog destination.");
      error.statusCode = 400;
      error.code = "BLOG_REQUIRED";
      throw error;
    }
    const blog = locked.generatedBlog || {};
    if (!blog.title || !String(blog.content || "").trim()) {
      const error = new Error("The generated article is empty.");
      error.statusCode = 400;
      throw error;
    }

    const accessToken = await getValidShopifyAccessToken(store);
    const collections = await listBlogCollections(store.storeHash, accessToken);
    const destination = collections.find((item) => item.id === locked.shopifyBlogId);
    if (!destination) {
      const error = new Error("The selected Shopify blog was not found on this store.");
      error.statusCode = 400;
      error.code = "BLOG_REQUIRED";
      throw error;
    }

    const live = publishImmediately();
    const article = await createArticle(store.storeHash, accessToken, {
      blogId: destination.id,
      title: blog.title,
      handle: blog.handle || slugify(blog.title),
      body: blog.content,
      summary: blog.summary || undefined,
      tags: blog.tags || [],
      isPublished: live,
      author: { name: "Chataffy AI" },
    });

    locked.shopifyBlogHandle = article.blogHandle || destination.handle || null;
    locked.shopifyArticleId = article.id;
    locked.shopifyArticleHandle = article.handle;
    locked.shopifyIsPublished = Boolean(article.isPublished);
    locked.shopifyArticleUrl = articleUrl(
      store,
      locked.shopifyBlogHandle,
      article.handle,
    );
    locked.status = "published";
    locked.errorMessage = null;
    await locked.save();
    return locked;
  } catch (error) {
    await BlogPublishingJob.updateOne(
      { _id: locked._id, status: "publishing" },
      {
        $set: {
          status: "failed",
          errorMessage: error.message || "Shopify publishing failed",
        },
      },
    );
    throw error;
  }
}

async function applyCallback({ jobId, n8nExecutionId, status, errorMessage }) {
  if (!isObjectId(jobId)) {
    const error = new Error("Job id is invalid.");
    error.statusCode = 400;
    throw error;
  }
  const job = await BlogPublishingJob.findById(jobId);
  if (!job) {
    const error = new Error("Publishing job not found.");
    error.statusCode = 404;
    throw error;
  }
  if (n8nExecutionId) {
    job.n8nExecutionId = String(n8nExecutionId).slice(0, 200);
  }
  if (status === "failed" && job.status === "queued") {
    job.status = "failed";
    job.errorMessage = String(errorMessage || "n8n could not start publishing").slice(0, 1000);
  }
  await job.save();
  return job;
}

module.exports = {
  requireInternalSecret,
  publicJob,
  listHome,
  getOwnedJob,
  startGenerateAndPublish,
  publishJob,
  applyCallback,
  isObjectId,
};
