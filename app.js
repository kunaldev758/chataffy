const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const path = require("path");
// const socketIo = require('socket.io');
const apiRoutes = require("./routes/");

const { initializeSocketController } = require('./socket');

const cors = require("cors");
dotenv.config();
const app = express();
const server = http.createServer(app);
// const io = socketIo(server);

// Initialize socket controller
// const socketController = initializeSocketController(io);
const socketController = initializeSocketController(server);

// // Apply socket middleware
// io.use(socketController.socketMiddleware);

// // Initialize socket events for each connection
// io.on('connection', (socket) => {
//   socketController.initializeSocketEvents(socket);
// });


mongoose.connect(process.env.MONGODB_URI);

app.use(cors());
// Share the 'io' object with all routes
// app.use((req, res, next) => {
//   req.io = io;
//   next();
// });

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", apiRoutes);

module.exports = { app, server };
