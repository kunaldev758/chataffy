const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const path = require("path");
const apiRoutes = require("./routes/");
const socketService = require("./helpers/socketHelper");

const cors = require("cors");
dotenv.config();
const app = express();
const server = http.createServer(app);

// Initialize socket.io
const io = socketService.initialize(server);
// Make io globally accessible
global.io = io;

mongoose.connect(process.env.MONGODB_URI);

app.use(cors());
// Share the 'io' object with all routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", apiRoutes);

module.exports = { app, server };
