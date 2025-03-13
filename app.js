const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const path = require('path');
// const {Server } = require('socket.io');
const apiRoutes = require('./routes/');
// const SocketController = require('./controllers/SocketController');
// const { initializeSocket } = require('./helpers/socketHelper');
const socketService = require("./helpers/socketHelper"); 
// const socketHelper = require('./helpers/socketHelper');
// const SocketController = require('./controllers/SocketController');
const cors = require('cors')
dotenv.config();
const app = express();
const server = http.createServer(app);
// Initialize WebSocket once
// Initialize socket event handlers
// Initialize socket.io
const io = socketService.initialize(server);
// const io = socketService.getIO();
// SocketController.initializeSocketEvents(io);
// socketService.initialize(server);
// const io = new Server(server, {
//   cors: {
//     origin: process.env.CLIENT_URL, // Replace with your frontend's URL
//     methods: ["GET", "POST"],
//   },
// });

mongoose.connect(process.env.MONGODB_URI);


app.use(cors())
// Share the 'io' object with all routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api', apiRoutes);

// Socket.IO connection
// module.exports = {io};
  // SocketController.handleSocketEvents(io);

// Start the server
// const PORT = process.env.PORT || 9000;
// server.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });


module.exports = { app, server };
