// helpers/socketHelper.js
let io;

const initialize = (server) => {
  io = require('socket.io')(server);
  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

const emitEvent = (event, data, room = null) => {
  const socketIO = getIO();
  if (room) {
    socketIO.to(room).emit(event, data);
  } else {
    socketIO.emit(event, data);
  }
};

module.exports = {
  initialize,
  getIO,
  emitEvent
};