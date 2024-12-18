const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const path = require('path');
const socketIo = require('socket.io');
const apiRoutes = require('./routes/');
const SocketController = require('./controllers/SocketController');
const cors = require('cors')
dotenv.config();
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {cors: {origin: "*"}});

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
  SocketController.handleSocketEvents(io);

// Start the server
const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
