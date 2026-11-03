const mongoose = require("mongoose");
const OpenAI = require("openai");
const Blog = require("../models/Blog");
const Store = require("../models/Store");
const { getValidShopifyAccessToken } = require("../routes/shopify");
const {
  listBlogCollections,
  createBlogCollection,
  createArticle,
  updateArticle,
} = require("../services/ShopifyContentService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BLOG_MODEL = process.env.OPENAI_CHAT_MODEL_BRIEF || "gpt-4.1-mini";

function scopeNames(scope) {
  return String(scope || "")
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function hasWriteContent(scope) {
  return scopeNames(scope).includes("write_content");
}

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags || "")
        .split(",")
        .map((tag) => tag.trim());
  const unique = [];
  for (const tag of list) {
    const clean = String(tag || "").trim().slice(0, 50);
    if (!clean || unique.includes(clean)) continue;
    unique.push(clean);
    if (unique.length >= 10) break;
  }
  return unique;
}

function publicBlog(blog) {
  return {
    _id: blog._id,
    storeId: blog.storeId || null,
    title: blog.title,
    content: blog.content || "",
    tags: blog.tags || [],
    topic: blog.topic || "",
    platform: blog.platform,
    status: blog.status,
    shopifyBlogId: blog.shopifyBlogId || null,
    shopifyArticleId: blog.shopifyArticleId || null,
    shopifyHandle: blog.shopifyHandle || null,
    errorMessage: blog.errorMessage || null,
    publishedAt: blog.publishedAt || null,
    createdAt: blog.createdAt,
    updatedAt: blog.updatedAt,
  };
}

function publicStore(store) {
  return {
    _id: store._id,
    name: store.name,
    storeHash: store.storeHash,
    storeUrl: store.storeUrl || "",
    status: store.status,
    hasWriteContent: hasWriteContent(store.scope),
  };
}

async function connectedStores(userId) {
  return Store.find({
    userId,
    platform: "shopify",
    status: { $ne: "uninstalled" },
    accessToken: { $nin: [null, ""] },
  })
    .select("name storeHash storeUrl status scope")
    .sort({ name: 1 })
    .lean();
}

function sendError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    status: false,
    status_code: statusCode,
    code: error.code || "BLOG_ERROR",
    message: error.message || fallback,
  });
}

exports.listBlogs = async (req, res) => {
  try {
    const userId = req.body.userId;
    const [blogs, stores] = await Promise.all([
      Blog.find({ userId }).sort({ updatedAt: -1 }).limit(50).lean(),
      connectedStores(userId),
    ]);
    return res.json({
      status: true,
      status_code: 200,
      blogs: blogs.map(publicBlog),
      stores: stores.map(publicStore),
    });
  } catch (error) {
    console.error("[Blog] list failed:", error.message);
    return sendError(res, error, "Could not load blogs");
  }
};

exports.generateBlog = async (req, res) => {
  try {
    const topic = String(req.body.topic || req.body.prompt || "").trim();
    const preferredTitle = String(req.body.title || "").trim().slice(0, 255);
    const tone = String(req.body.tone || "clear and helpful").trim().slice(0, 80);

    if (!topic || topic.length < 3) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Add a topic of at least 3 characters.",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        status: false,
        status_code: 500,
        message: "AI blog generation is not configured.",
      });
    }

    const completion = await openai.chat.completions.create({
      model: BLOG_MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write original blog articles for a Shopify store. Return JSON with keys title (string), content (HTML string using only h2, h3, p, ul, ol, li, strong, em, a), and tags (array of 3 to 6 short strings). Do not include script, style, or iframe tags. Do not mention that you are an AI.",
        },
        {
          role: "user",
          content: `Topic: ${topic.slice(0, 500)}\nPreferred title: ${preferredTitle || "choose a clear title"}\nTone: ${tone}`,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        status: false,
        status_code: 502,
        message: "AI returned an unreadable article. Try again.",
      });
    }

    const title = String(parsed.title || preferredTitle || topic).trim().slice(0, 255);
    const content = sanitizeHtml(parsed.content || parsed.body || "").slice(0, 100000);
    if (!title || !content) {
      return res.status(502).json({
        status: false,
        status_code: 502,
        message: "AI did not return a title and article body.",
      });
    }

    return res.json({
      status: true,
      status_code: 200,
      blog: {
        title,
        content,
        tags: normalizeTags(parsed.tags),
        topic: topic.slice(0, 500),
      },
    });
  } catch (error) {
    console.error("[Blog] generate failed:", error.message);
    return sendError(res, error, "Could not generate the blog");
  }
};

exports.saveBlog = async (req, res) => {
  try {
    const userId = req.body.userId;
    const title = String(req.body.title || "").trim().slice(0, 255);
    const content = sanitizeHtml(req.body.content || "").slice(0, 100000);
    const tags = normalizeTags(req.body.tags);
    const topic = String(req.body.topic || "").trim().slice(0, 500);
    const storeId = req.body.storeId || null;
    const shopifyBlogId = req.body.shopifyBlogId
      ? String(req.body.shopifyBlogId).slice(0, 200)
      : null;

    if (!title) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Blog title is required.",
      });
    }
    if (storeId && !isObjectId(storeId)) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Selected store is invalid.",
      });
    }
    if (storeId) {
      const store = await Store.findOne({
        _id: storeId,
        userId,
        platform: "shopify",
      }).select("_id");
      if (!store) {
        return res.status(403).json({
          status: false,
          status_code: 403,
          message: "That Shopify store is not connected to this account.",
        });
      }
    }

    const payload = {
      title,
      content,
      tags,
      topic,
      storeId: storeId || null,
      shopifyBlogId,
      platform: "shopify",
    };

    let blog;
    if (req.body.id) {
      if (!isObjectId(req.body.id)) {
        return res.status(400).json({
          status: false,
          status_code: 400,
          message: "Blog id is invalid.",
        });
      }
      blog = await Blog.findOneAndUpdate(
        { _id: req.body.id, userId },
        { $set: payload },
        { new: true },
      );
      if (!blog) {
        return res.status(404).json({
          status: false,
          status_code: 404,
          message: "Blog not found.",
        });
      }
    } else {
      blog = await Blog.create({
        ...payload,
        userId,
        status: "draft",
      });
    }

    return res.json({
      status: true,
      status_code: 200,
      blog: publicBlog(blog),
    });
  } catch (error) {
    console.error("[Blog] save failed:", error.message);
    return sendError(res, error, "Could not save the blog");
  }
};

exports.getBlogStatus = async (req, res) => {
  try {
    const userId = req.body.userId;
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Blog id is invalid.",
      });
    }
    const blog = await Blog.findOne({ _id: req.params.id, userId }).lean();
    if (!blog) {
      return res.status(404).json({
        status: false,
        status_code: 404,
        message: "Blog not found.",
      });
    }
    return res.json({
      status: true,
      status_code: 200,
      blog: publicBlog(blog),
    });
  } catch (error) {
    console.error("[Blog] status failed:", error.message);
    return sendError(res, error, "Could not load publishing status");
  }
};

exports.listShopifyBlogs = async (req, res) => {
  try {
    const userId = req.body.userId;
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
      userId,
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
    if (!hasWriteContent(store.scope) && !scopeNames(store.scope).includes("read_content")) {
      return res.status(403).json({
        status: false,
        status_code: 403,
        code: "SHOPIFY_SCOPE_REQUIRED",
        message:
          "This store needs content permissions. Reopen Chataffy in Shopify Admin and approve them.",
      });
    }

    const accessToken = await getValidShopifyAccessToken(store);
    const blogs = await listBlogCollections(store.storeHash, accessToken);
    return res.json({
      status: true,
      status_code: 200,
      blogs,
      hasWriteContent: hasWriteContent(store.scope),
    });
  } catch (error) {
    console.error("[Blog] shopify blogs failed:", error.message);
    return sendError(res, error, "Could not load Shopify blogs");
  }
};

async function resolveShopifyBlogId(store, accessToken, requestedId) {
  if (requestedId) return requestedId;
  const blogs = await listBlogCollections(store.storeHash, accessToken);
  if (blogs.length === 1) return blogs[0].id;
  if (blogs.length === 0) {
    const created = await createBlogCollection(store.storeHash, accessToken, "News");
    return created.id;
  }
  const error = new Error("Select which Shopify blog this article should go in.");
  error.statusCode = 400;
  error.code = "BLOG_REQUIRED";
  throw error;
}

exports.publishBlog = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { blogId, storeId } = req.body;
    const publishNow = req.body.isPublished !== false && req.body.mode !== "draft";

    if (!isObjectId(blogId) || !isObjectId(storeId)) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Blog and Shopify store are required.",
      });
    }

    const [blog, store] = await Promise.all([
      Blog.findOne({ _id: blogId, userId }),
      Store.findOne({
        _id: storeId,
        userId,
        platform: "shopify",
        status: { $ne: "uninstalled" },
      }),
    ]);

    if (!blog) {
      return res.status(404).json({
        status: false,
        status_code: 404,
        message: "Blog not found.",
      });
    }
    if (!store) {
      return res.status(403).json({
        status: false,
        status_code: 403,
        message: "That Shopify store is not connected to this account.",
      });
    }
    if (!blog.title || !String(blog.content || "").trim()) {
      return res.status(400).json({
        status: false,
        status_code: 400,
        message: "Add a title and article body before publishing.",
      });
    }
    if (!hasWriteContent(store.scope)) {
      return res.status(403).json({
        status: false,
        status_code: 403,
        code: "SHOPIFY_SCOPE_REQUIRED",
        message:
          "This store is missing write_content. In Shopify Partner Dashboard add that scope, restart the backend, then reopen Chataffy in Shopify Admin and approve the new permission.",
      });
    }

    const accessToken = await getValidShopifyAccessToken(store);
    const shopifyBlogId = await resolveShopifyBlogId(
      store,
      accessToken,
      req.body.shopifyBlogId || blog.shopifyBlogId,
    );

    const articleFields = {
      title: blog.title,
      body: blog.content,
      tags: blog.tags || [],
      isPublished: publishNow,
      author: { name: store.name || "Chataffy" },
    };

    const requestedBlogId = req.body.shopifyBlogId || blog.shopifyBlogId || null;
    const sameStore =
      blog.storeId &&
      String(blog.storeId) === String(store._id) &&
      blog.shopifyArticleId &&
      (!requestedBlogId || !blog.shopifyBlogId || requestedBlogId === blog.shopifyBlogId);

    const article = sameStore
      ? await updateArticle(store.storeHash, accessToken, blog.shopifyArticleId, articleFields)
      : await createArticle(store.storeHash, accessToken, {
          ...articleFields,
          blogId: shopifyBlogId,
        });

    blog.storeId = store._id;
    blog.shopifyBlogId = article.blogId || shopifyBlogId;
    blog.shopifyArticleId = article.id;
    blog.shopifyHandle = article.handle;
    blog.status = article.isPublished || publishNow ? "published" : "draft";
    blog.errorMessage = null;
    blog.publishedAt = blog.status === "published" ? new Date() : blog.publishedAt;
    await blog.save();

    return res.json({
      status: true,
      status_code: 200,
      message: blog.status === "published" ? "Published to Shopify." : "Saved as a Shopify draft.",
      blog: publicBlog(blog),
    });
  } catch (error) {
    console.error("[Blog] publish failed:", error.message);
    const statusCode = error.statusCode || 500;
    if (
      isObjectId(req.body.blogId) &&
      req.body.userId &&
      (statusCode >= 500 || error.code === "SHOPIFY_ERROR" || error.code === "SHOPIFY_SCOPE_REQUIRED")
    ) {
      await Blog.updateOne(
        { _id: req.body.blogId, userId: req.body.userId },
        { $set: { status: "failed", errorMessage: error.message || "Publish failed" } },
      ).catch(() => {});
    }
    return sendError(res, error, "Could not publish the blog");
  }
};
