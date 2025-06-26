const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const rateLimit = require('express-rate-limit');
const path = require("path");
const apiRoutes = require("./routes/");

const { initializeSocketController } = require("./socket");

const cors = require("cors");
dotenv.config();
const app = express();
const server = http.createServer(app);

// Initialize socket controller
initializeSocketController(server);

mongoose.connect(process.env.MONGODB_URI);

app.use(cors());

// Apply rate limit to all requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter); // apply to all requests

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", apiRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

module.exports = { app, server };
