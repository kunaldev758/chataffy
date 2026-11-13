const BlogPost = require("../models/BlogPost");
const {
  generateBlogFromTopic,
  sanitizeHtml,
} = require("../services/blog/blogGenerationService");

const BlogController = {};

BlogController.generateBlog = async (req, res) => {
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
    console.error("[Blog] generateBlog error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to generate blog.",
    });
  }
};

BlogController.updateBlog = async (req, res) => {
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
    console.error("[Blog] updateBlog error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to update blog.",
    });
  }
};

BlogController.listPosts = async (req, res) => {
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
    console.error("[Blog] listPosts error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch posts.",
    });
  }
};

BlogController.getBlog = async (req, res) => {
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

module.exports = BlogController;
