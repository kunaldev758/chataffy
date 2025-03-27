const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
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

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", apiRoutes);

module.exports = { app, server };
