// helpers/socketHelper.js
let io;

const initialize = (server) => {
  io = require("socket.io")(server);
  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // Handle user authentication and room joining
    socket.on("join", (userId) => {
      if (userId) {
        socket.join("user" + userId);
        console.log(`User ${userId} joined room: user${userId}`);
      }
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized");
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
  emitEvent,
};