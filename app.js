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

const { initializeSocketController } = require("./socket");

const cors = require("cors");
dotenv.config();
const app = express();
const server = http.createServer(app);

// Initialize socket controller
initializeSocketController(server);

mongoose.connect(process.env.MONGODB_URI);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("Created uploads directory");
}

app.use(cors());

// Apply rate limit to all requests
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter); // apply to all requests

app.use(express.json());
app.use("/uploads", express.static(uploadsDir));
app.use("/api", apiRoutes);
app.use('/api/paypal', paymentsRouter);

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
