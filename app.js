const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const rateLimit = require('express-rate-limit');
const path = require("path");
const fs = require("fs");
const apiRoutes = require("./routes/");
const paymentsRouter = require('./routes/payments');
const cron = require('node-cron');
const { downgradeExpiredPlans } = require('./services/planCronService');
const bigcommerceRoutes = require("./routes/bigcommerce");
const shopifyRoutes = require("./routes/shopify");
const { initializeSocketController } = require("./socket");

const cors = require("cors");
const cookieParser = require("cookie-parser");
dotenv.config();
const app = express();
const server = http.createServer(app);

// Initialize socket controller
initializeSocketController(server);

mongoose.connect(process.env.MONGODB_URI);

mongoose.connection.once("connected", async () => {
  try {
    const {
      loadScrapeProxySettingsIntoRuntime,
    } = require("./services/scraperSettingsService");
    await loadScrapeProxySettingsIntoRuntime();
  } catch (error) {
    console.error("[scraper] Failed to load proxy settings from DB:", error);
  }
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("Created uploads directory");
}

const corsAllowList = (process.env.CORS_ORIGINS ||
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:9001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (corsAllowList.includes(origin)) {
        return callback(null, true);
      }
      if (
        process.env.NODE_ENV !== "production" &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(cookieParser());

// Apply rate limit to all requests
// const limiter = rateLimit({
//   windowMs: 1 * 60 * 1000, // 15 minutes
//   max: 50, // limit each IP to 100 requests per windowMs
//   standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
//   legacyHeaders: false, // Disable the `X-RateLimit-*` headers
// });

// app.use(limiter); // apply to all requests

app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.originalUrl?.startsWith("/api/shopify/webhooks")) {
        req.rawBody = buf;
      }
    },
  })
);
app.use("/uploads", express.static(uploadsDir));
app.use("/api", apiRoutes);
app.use('/api/paypal', paymentsRouter);
app.use('/api/bigcommerce', bigcommerceRoutes);
app.use("/api/shopify", shopifyRoutes);

// check ip address ---> 

app.get('/check-ip', (req, res) => {
  res.json({
    xClientIp: req.headers['x-client-ip'],
    xForwardedFor: req.headers['x-forwarded-for'],
    xRealIp: req.headers['x-real-ip'],
    remoteAddress: req.socket.remoteAddress
  });
});

// Schedule the plan expiry check to run every day at midnight
cron.schedule('0 0 * * *', () => {
  console.log('Running plan expiry check...');
  downgradeExpiredPlans();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

module.exports = { app, server };
