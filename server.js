// server.js
const { app, server } = require('./app');
const socketHelper = require('./helpers/socketHelper');
const SocketController = require('./controllers/SocketController');

// Initialize socket event handlers
const io = socketHelper.getIO();
SocketController.initializeSocketEvents(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});