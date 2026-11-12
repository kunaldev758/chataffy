const WordPressConnection = require("../models/WordPressConnection");
const BlogPost = require("../models/BlogPost");
const { encryptSecret, decryptSecret } = require("../utils/secretCrypto");
const {
  testWordPressConnection,
  createWordPressPost,
  normalizeSiteUrl,
} = require("../services/wordpress/wordpressService");
const {
  generateBlogFromTopic,
  sanitizeHtml,
} = require("../services/wordpress/blogGenerationService");

const WordPressController = {};

function publicConnection(doc) {
  if (!doc) {
    return {
      isConnected: false,
      siteUrl: "",
      username: "",
      displayName: "",
      lastVerifiedAt: null,
    };
  }
  return {
    isConnected: !!doc.isConnected,
    siteUrl: doc.siteUrl || "",
    username: doc.username || "",
    displayName: doc.displayName || "",
    lastVerifiedAt: doc.lastVerifiedAt || null,
    connectedAt: doc.updatedAt || doc.createdAt || null,
  };
}

async function getDecryptedCredentials(userId) {
  const conn = await WordPressConnection.findOne({ userId }).lean();
  if (!conn || !conn.isConnected) {
    throw new Error("WordPress is not connected. Connect your site first.");
  }
  return {
    siteUrl: conn.siteUrl,
    username: conn.username,
    applicationPassword: decryptSecret(conn.applicationPassword),
  };
}

WordPressController.connect = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { siteUrl, username, applicationPassword } = req.body;

    if (!siteUrl || !username || !applicationPassword) {
      return res.status(400).json({
        status: false,
        message: "Website URL, username, and Application Password are required.",
      });
    }

    const verified = await testWordPressConnection({
      siteUrl,
      username,
      applicationPassword,
    });

    const encrypted = encryptSecret(applicationPassword);
    const doc = await WordPressConnection.findOneAndUpdate(
      { userId },
      {
        $set: {
          platform: "wordpress",
          siteUrl: verified.siteUrl,
          username: String(username).trim(),
          applicationPassword: encrypted,
          isConnected: true,
          lastVerifiedAt: new Date(),
          displayName: verified.displayName || "",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      status: true,
      message: "WordPress connected successfully.",
      connection: publicConnection(doc),
    });
  } catch (error) {
    console.error("[WordPress] connect error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to connect WordPress.",
    });
  }
};

WordPressController.status = async (req, res) => {
  try {
    const userId = req.body.userId;
    const doc = await WordPressConnection.findOne({ userId }).lean();
    return res.json({
      status: true,
      connection: publicConnection(doc),
    });
  } catch (error) {
    console.error("[WordPress] status error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch WordPress connection status.",
    });
  }
};

WordPressController.testConnection = async (req, res) => {
  try {
    const userId = req.body.userId;
    const creds = await getDecryptedCredentials(userId);
    const verified = await testWordPressConnection(creds);

    await WordPressConnection.updateOne(
      { userId },
      {
        $set: {
          lastVerifiedAt: new Date(),
          displayName: verified.displayName || "",
          isConnected: true,
        },
      }
    );

    return res.json({
      status: true,
      message: "WordPress connection is working.",
      connection: {
        isConnected: true,
        siteUrl: verified.siteUrl,
        username: creds.username,
        displayName: verified.displayName,
        lastVerifiedAt: new Date(),
      },
    });
  } catch (error) {
    console.error("[WordPress] testConnection error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "WordPress connection test failed.",
    });
  }
};

WordPressController.disconnect = async (req, res) => {
  try {
    const userId = req.body.userId;
    await WordPressConnection.findOneAndDelete({ userId });
    return res.json({
      status: true,
      message: "WordPress disconnected.",
      connection: publicConnection(null),
    });
  } catch (error) {
    console.error("[WordPress] disconnect error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to disconnect WordPress.",
    });
  }
};

WordPressController.generateBlog = async (req, res) => {
  try {
    const userId = req.body.userId;
    const {
      topic,
      tone = "Professional",
      language = "English",
      length = "1500 words",
      agentId = null,
    } = req.body;

    const generated = await generateBlogFromTopic({
      topic,
      tone,
      language,
      length,
    });

    const blog = await BlogPost.create({
      userId,
      agentId: agentId || null,
      topic: String(topic).trim(),
      tone,
      language,
      length,
      ...generated,
      status: "generated",
    });

    return res.json({
      status: true,
      message: "Blog generated successfully.",
      blog,
    });
  } catch (error) {
    console.error("[WordPress] generateBlog error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to generate blog.",
    });
  }
};

WordPressController.updateBlog = async (req, res) => {
  try {
    const userId = req.body.userId;
    const {
      blogId,
      title,
      content,
      excerpt,
      tags,
      metaTitle,
      metaDescription,
    } = req.body;

    if (!blogId) {
      return res.status(400).json({
        status: false,
        message: "blogId is required.",
      });
    }

    const blog = await BlogPost.findOne({ _id: blogId, userId });
    if (!blog) {
      return res.status(404).json({
        status: false,
        message: "Blog not found.",
      });
    }

    if (title != null) blog.title = String(title).trim();
    if (content != null) blog.content = sanitizeHtml(String(content));
    if (excerpt != null) blog.excerpt = String(excerpt).trim();
    if (Array.isArray(tags)) {
      blog.tags = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
    }
    if (metaTitle != null) blog.metaTitle = String(metaTitle).trim();
    if (metaDescription != null) {
      blog.metaDescription = String(metaDescription).trim();
    }

    await blog.save();

    return res.json({
      status: true,
      message: "Blog updated.",
      blog,
    });
  } catch (error) {
    console.error("[WordPress] updateBlog error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to update blog.",
    });
  }
};

WordPressController.publish = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { blogId, status: wpStatus = "publish" } = req.body;

    if (!blogId) {
      return res.status(400).json({
        status: false,
        message: "blogId is required.",
      });
    }

    const blog = await BlogPost.findOne({ _id: blogId, userId });
    if (!blog) {
      return res.status(404).json({
        status: false,
        message: "Blog not found.",
      });
    }
    if (!blog.title || !blog.content) {
      return res.status(400).json({
        status: false,
        message: "Blog title and content are required before publishing.",
      });
    }

    const creds = await getDecryptedCredentials(userId);
    const allowedStatus = ["draft", "publish", "pending", "future"].includes(
      wpStatus
    )
      ? wpStatus
      : "publish";

    try {
      const result = await createWordPressPost({
        ...creds,
        title: blog.title,
        content: blog.content,
        excerpt: blog.excerpt,
        status: allowedStatus,
        tags: blog.tags,
      });

      blog.wordpressPostId = result.postId;
      blog.wordpressPostUrl = result.postUrl;
      blog.wordpressStatus = result.status;
      blog.publishedAt = new Date();
      blog.status = result.status === "publish" ? "published" : "generated";
      blog.publishError = "";
      await blog.save();

      return res.json({
        status: true,
        message:
          result.status === "publish"
            ? "Blog published to WordPress."
            : `Blog saved on WordPress as ${result.status}.`,
        blog,
        wordpress: result,
      });
    } catch (publishError) {
      blog.status = "failed";
      blog.publishError = publishError.message || "Publish failed";
      await blog.save();
      throw publishError;
    }
  } catch (error) {
    console.error("[WordPress] publish error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to publish blog.",
    });
  }
};

WordPressController.listPosts = async (req, res) => {
  try {
    const userId = req.body.userId;
    const limit = Math.min(parseInt(req.body.limit, 10) || 20, 50);
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      BlogPost.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments({ userId }),
    ]);

    return res.json({
      status: true,
      posts,
      total,
      page,
      limit,
    });
  } catch (error) {
    console.error("[WordPress] listPosts error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch published posts.",
    });
  }
};

WordPressController.getBlog = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { blogId } = req.body;
    if (!blogId) {
      return res.status(400).json({
        status: false,
        message: "blogId is required.",
      });
    }
    const blog = await BlogPost.findOne({ _id: blogId, userId }).lean();
    if (!blog) {
      return res.status(404).json({
        status: false,
        message: "Blog not found.",
      });
    }
    return res.json({ status: true, blog });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: "Failed to fetch blog.",
    });
  }
};

// used only to keep normalizeSiteUrl referenced if needed by tests
WordPressController._normalizeSiteUrl = normalizeSiteUrl;

module.exports = WordPressController;
