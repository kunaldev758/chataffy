const axios = require("axios");
const OpenAI = require("openai");
const sanitizeHtml = require("sanitize-html");
const Store = require("../models/Store");
const BlogPost = require("../models/BlogPost");
const appEvents = require("../events");
const { getResolvedModelConfig } = require("../services/aiModelService");
const {
  getValidShopifyAccessToken,
} = require("../routes/shopify");

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const SHOPIFY_WRITE_CONTENT_SCOPE = "write_content";
const BC_CONTENT_MODIFY_HINTS = [
  "store_v2_content",
  "content_modify",
  "modify_content",
];

function cleanBlogHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "h1",
      "h2",
      "h3",
      "img",
      "figure",
      "figcaption",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

function parseScopeList(scope) {
  return String(scope || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasShopifyWriteContent(scope) {
  return parseScopeList(scope).includes(SHOPIFY_WRITE_CONTENT_SCOPE);
}

function hasBigCommerceContentModify(scope) {
  const scopes = parseScopeList(scope).map((s) => s.toLowerCase());
  // BigCommerce modify scope is store_v2_content; read-only is store_v2_content_read_only.
  if (scopes.includes("store_v2_content")) return true;
  return scopes.some((s) =>
    BC_CONTENT_MODIFY_HINTS.some(
      (hint) => s.includes(hint) && !s.includes("read_only"),
    ),
  );
}

function sessionUserId(req) {
  return req.body?.userId || null;
}

function sessionStoreHash(req) {
  return req.authSession?.platform === "shopify"
    ? req.authSession?.storeHash || null
    : null;
}

function n8nSecret() {
  return (
    process.env.N8N_WEBHOOK_SECRET ||
    process.env.N8N_SHARED_SECRET ||
    process.env.N8N_INTERNAL_API_SECRET ||
    ""
  );
}

function n8nWebhookUrl() {
  return (
    process.env.N8N_WEBHOOK_URL ||
    process.env.N8N_BLOG_WEBHOOK_URL ||
    ""
  ).trim();
}

function backendBaseUrl() {
  const base = (process.env.BASE_URL || "").trim();
  if (!base) return "";
  return base.endsWith("/") ? base : `${base}/`;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty model response");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

/**
 * GET/POST — list installed commerce stores for the authenticated merchant.
 * Never returns access tokens.
 */
async function listStores(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const filter = {
      userId,
      status: "installed",
      accessToken: { $ne: null },
    };

    const boundStoreHash = sessionStoreHash(req);
    const sessionPlatform = req.authSession?.platform;
    if (boundStoreHash) {
      filter.storeHash = boundStoreHash;
      filter.platform = "shopify";
    } else if (sessionPlatform === "bigcommerce") {
      filter.platform = "bigcommerce";
    } else if (sessionPlatform === "shopify") {
      filter.platform = "shopify";
    }

    const stores = await Store.find(filter)
      .select("storeHash storeUrl platform name email scope status createdAt")
      .sort({ createdAt: 1 })
      .lean();

    const mapped = stores.map((store) => {
      const canPublish =
        store.platform === "shopify"
          ? hasShopifyWriteContent(store.scope)
          : hasBigCommerceContentModify(store.scope);
      return {
        storeHash: store.storeHash,
        storeUrl: store.storeUrl,
        platform: store.platform,
        name: store.name,
        email: store.email,
        canPublish,
        missingScope:
          store.platform === "shopify"
            ? canPublish
              ? null
              : SHOPIFY_WRITE_CONTENT_SCOPE
            : canPublish
              ? null
              : "Content: modify",
      };
    });

    return res.json({ status: true, stores: mapped });
  } catch (error) {
    console.error("[blog] listStores failed:", error.message);
    return res
      .status(500)
      .json({ status: false, message: "Could not load stores" });
  }
}

/**
 * POST — generate blog draft with existing OpenAI / brief-chat model config.
 */
async function generateBlog(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const {
      topic,
      tone = "friendly",
      language = "English",
    } = req.body || {};

    const topicText = String(topic || "").trim();
    if (!topicText || topicText.length > 300) {
      return res
        .status(400)
        .json({ status: false, message: "Valid topic required (max 300 chars)" });
    }

    const cfg = await getResolvedModelConfig("brief-chat", ["chat"]);
    if (!cfg?.apiKey) {
      return res.status(500).json({
        status: false,
        message: "AI provider is not configured",
      });
    }

    const openai = new OpenAI({ apiKey: cfg.apiKey });
    const completion = await openai.chat.completions.create({
      model: cfg.model || process.env.OPENAI_CHAT_MODEL_BRIEF || "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You are an SEO blog writer for ecommerce merchants. Reply ONLY with JSON: " +
            '{"title":"","summary":"max 160 chars","tags":["..."],"html":"article body in HTML using h2/h3/p/ul/li, no h1, no <html> wrapper"}',
        },
        {
          role: "user",
          content: `Topic: ${topicText}\nTone: ${tone}\nLanguage: ${language}\nLength: ~800 words`,
        },
      ],
    });

    const blog = extractJsonObject(completion.choices?.[0]?.message?.content);
    if (!blog?.title || !blog?.html) {
      return res.status(502).json({
        status: false,
        message: "AI returned an incomplete blog draft",
      });
    }

    blog.html = cleanBlogHtml(blog.html);
    blog.summary = String(blog.summary || "").slice(0, 160);
    blog.tags = Array.isArray(blog.tags)
      ? blog.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
      : [];

    return res.json({
      status: true,
      blog: {
        title: String(blog.title).trim(),
        summary: blog.summary,
        tags: blog.tags,
        html: blog.html,
        topic: topicText,
        tone,
        language,
      },
    });
  } catch (error) {
    console.error("[blog] generate failed:", error.message);
    return res
      .status(500)
      .json({ status: false, message: "Blog generation failed" });
  }
}

/**
 * Resolve a store the merchant is allowed to publish to.
 */
async function resolvePublishStore(req, storeHash) {
  const userId = sessionUserId(req);
  const boundStoreHash = sessionStoreHash(req);

  if (!storeHash) {
    throw Object.assign(new Error("storeHash is required"), { status: 400 });
  }

  if (boundStoreHash && boundStoreHash !== storeHash) {
    throw Object.assign(
      new Error("You can only publish to the store bound to this session"),
      { status: 403 },
    );
  }

  const store = await Store.findOne({
    storeHash,
    userId,
    status: "installed",
  });

  if (!store || !store.accessToken) {
    throw Object.assign(new Error("Store not found or not installed"), {
      status: 404,
    });
  }

  if (store.platform === "shopify" && !hasShopifyWriteContent(store.scope)) {
    throw Object.assign(
      new Error(
        "Shopify store is missing write_content permission. Reopen the app from Shopify admin to approve the new scope.",
      ),
      { status: 403, code: "MISSING_WRITE_CONTENT" },
    );
  }

  if (
    store.platform === "bigcommerce" &&
    !hasBigCommerceContentModify(store.scope)
  ) {
    throw Object.assign(
      new Error(
        "BigCommerce app needs Content: modify. Update OAuth scopes and re-authorize the app.",
      ),
      { status: 403, code: "MISSING_CONTENT_MODIFY" },
    );
  }

  return store;
}

/**
 * POST — start publish via n8n. Sends a fresh access token; n8n must not store it.
 */
async function publishBlog(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const webhookUrl = n8nWebhookUrl();
    const sharedSecret = n8nSecret();
    if (!webhookUrl || !sharedSecret) {
      return res.status(503).json({
        status: false,
        message:
          "Blog publishing is not configured (N8N_WEBHOOK_URL / N8N_WEBHOOK_SECRET)",
      });
    }

    const baseUrl = backendBaseUrl();
    if (!baseUrl) {
      return res.status(503).json({
        status: false,
        message: "BASE_URL is not configured for n8n callbacks",
      });
    }

    const {
      title,
      html,
      summary = "",
      tags = [],
      topic = "",
      tone = "friendly",
      language = "English",
      publishNow = process.env.BLOG_PUBLISH_IMMEDIATELY !== "false",
      storeHash,
    } = req.body || {};

    if (!title || !html) {
      return res
        .status(400)
        .json({ status: false, message: "title and html are required" });
    }

    const store = await resolvePublishStore(req, storeHash);
    const cleanedHtml = cleanBlogHtml(html);
    const normalizedTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
      : [];

    const accessToken =
      store.platform === "shopify"
        ? await getValidShopifyAccessToken(store)
        : store.accessToken;

    const requestId = `${store.storeHash}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const blogPost = await BlogPost.create({
      userId,
      storeHash: store.storeHash,
      platform: store.platform,
      requestId,
      topic: String(topic || "").slice(0, 300),
      title: String(title).trim(),
      summary: String(summary || "").slice(0, 160),
      tags: normalizedTags,
      html: cleanedHtml,
      tone,
      language,
      publishNow: Boolean(publishNow),
      status: "publishing",
    });

    const payload = {
      platform: store.platform,
      storeHash: store.storeHash,
      accessToken,
      apiVersion: SHOPIFY_API_VERSION,
      blog: {
        title: blogPost.title,
        html: blogPost.html,
        summary: blogPost.summary,
        tags: blogPost.tags,
        publishNow: blogPost.publishNow,
      },
      callbackUrl: `${baseUrl}api/blog/n8n-callback`,
      requestId,
    };

    try {
      await axios.post(webhookUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          "x-n8n-secret": sharedSecret,
        },
        timeout: 15000,
      });
    } catch (webhookError) {
      blogPost.status = "failed";
      blogPost.error =
        webhookError.response?.data?.message ||
        webhookError.message ||
        "n8n webhook failed";
      await blogPost.save();
      console.error("[blog] n8n webhook failed:", blogPost.error);
      return res.status(502).json({
        status: false,
        message: "Could not start publishing with n8n",
        requestId,
      });
    }

    return res.json({
      status: true,
      requestId,
      blogPostId: blogPost._id,
      message: "Publishing started",
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error("[blog] publish failed:", error.message);
    }
    return res.status(status).json({
      status: false,
      message: error.message || "Could not start publishing",
      code: error.code || undefined,
    });
  }
}

/**
 * POST — n8n callback (shared secret auth, not session auth).
 */
async function n8nCallback(req, res) {
  const expected = n8nSecret();
  const provided = req.get("x-n8n-secret");
  if (!expected || provided !== expected) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const {
      requestId,
      success,
      url = null,
      error = null,
      storeHash = null,
      externalId = null,
    } = req.body || {};

    if (!requestId) {
      return res.status(400).json({ status: false, message: "requestId required" });
    }

    const blogPost = await BlogPost.findOne({ requestId });
    if (!blogPost) {
      console.warn("[blog] callback for unknown requestId:", requestId);
      return res.sendStatus(200);
    }

    if (storeHash && blogPost.storeHash !== storeHash) {
      console.warn("[blog] callback storeHash mismatch:", {
        requestId,
        expected: blogPost.storeHash,
        got: storeHash,
      });
      return res.status(400).json({ status: false, message: "storeHash mismatch" });
    }

    blogPost.status = success ? "published" : "failed";
    blogPost.publishedUrl = success ? url || blogPost.publishedUrl : null;
    blogPost.externalId = externalId || blogPost.externalId;
    blogPost.error = success ? null : String(error || "Publish failed");
    await blogPost.save();

    appEvents.emit("userEvent", String(blogPost.userId), null, "blog-published", {
      requestId: blogPost.requestId,
      blogPostId: blogPost._id,
      success: Boolean(success),
      url: blogPost.publishedUrl,
      error: blogPost.error,
      storeHash: blogPost.storeHash,
      platform: blogPost.platform,
      status: blogPost.status,
    });

    console.log("[blog] callback", {
      requestId,
      success: Boolean(success),
      url: blogPost.publishedUrl,
      error: blogPost.error,
      storeHash: blogPost.storeHash,
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("[blog] callback failed:", error.message);
    return res.status(500).json({ status: false, message: "Callback failed" });
  }
}

/**
 * GET — publish status by requestId (owner-scoped).
 */
async function getPublishStatus(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const requestId = req.params.requestId || req.query.requestId;
    if (!requestId) {
      return res
        .status(400)
        .json({ status: false, message: "requestId required" });
    }

    const blogPost = await BlogPost.findOne({ requestId, userId })
      .select(
        "requestId status publishedUrl error title storeHash platform createdAt updatedAt",
      )
      .lean();

    if (!blogPost) {
      return res.status(404).json({ status: false, message: "Not found" });
    }

    return res.json({ status: true, blogPost });
  } catch (error) {
    console.error("[blog] getPublishStatus failed:", error.message);
    return res
      .status(500)
      .json({ status: false, message: "Could not load status" });
  }
}

/**
 * GET — recent blog posts for the merchant (optional history UI).
 */
async function listBlogPosts(req, res) {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const boundStoreHash = sessionStoreHash(req);
    const filter = { userId };
    if (boundStoreHash) filter.storeHash = boundStoreHash;

    const posts = await BlogPost.find(filter)
      .select(
        "requestId title summary tags status publishedUrl error storeHash platform createdAt updatedAt",
      )
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    return res.json({ status: true, posts });
  } catch (error) {
    console.error("[blog] listBlogPosts failed:", error.message);
    return res
      .status(500)
      .json({ status: false, message: "Could not load blog posts" });
  }
}

module.exports = {
  listStores,
  generateBlog,
  publishBlog,
  n8nCallback,
  getPublishStatus,
  listBlogPosts,
  // exported for unit-style checks / shopify auth reuse
  hasShopifyWriteContent,
  parseScopeList,
};
