const express = require("express");
const rateLimit = require("express-rate-limit");
const middleware = require("../middleware/authMiddleware");
const BlogController = require("../controllers/BlogController");

const router = express.Router();

// Auth middleware assigns req.body.userId; ensure body exists on GET.
router.use((req, _res, next) => {
  if (!req.body || typeof req.body !== "object") req.body = {};
  next();
});

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: "Too many blog generation requests. Please try again later.",
  },
});

const publishLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: "Too many publish requests. Please try again later.",
  },
});

// Authenticated merchant endpoints
router.get("/stores", middleware, BlogController.listStores);
router.get("/posts", middleware, BlogController.listBlogPosts);
router.get("/status/:requestId", middleware, BlogController.getPublishStatus);
router.post("/generate", middleware, generateLimiter, BlogController.generateBlog);
router.post("/publish", middleware, publishLimiter, BlogController.publishBlog);

// n8n → backend callback (shared-secret auth inside controller)
router.post("/n8n-callback", BlogController.n8nCallback);

module.exports = router;
