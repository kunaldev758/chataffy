const express = require("express");
const WixController = require("../controllers/WixController");
const middleware = require("../middleware/authMiddleware");

const router = express.Router();

// Public install / OAuth browser redirects
router.get("/callback", WixController.callback);
router.get("/install", WixController.appInstallEntry);

// Authenticated dashboard APIs (FE uses POST via fetchData)
router.post("/connect", middleware, WixController.connect);
router.post("/status", middleware, WixController.status);
router.post("/disconnect", middleware, WixController.disconnect);
router.post("/publish", middleware, WixController.publish);
router.post("/publish-blog", middleware, WixController.publish);

module.exports = router;
