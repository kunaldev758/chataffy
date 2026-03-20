// socket.js
const appEvents = require("./events");
const socketIO = require("socket.io");
const { myMiddleware } = require("./middleware/socketMiddleware");
const { initializeClientEvents } = require("./helpers/clientHandlers");
const { initializeVisitorEvents } = require("./helpers/visitorHandlers");

let io;

const initializeSocketController = (server) => {
  io = socketIO(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Listen for events from your controllers
  appEvents.on("userEvent", (userId, agentId, eventName, data) => {
    const userRoom = `user-${userId}`;
    io.to(userRoom).emit(eventName, data);
    const agentRoom = `user-${agentId}`;
    io.to(agentRoom).emit(eventName, data);
  });

  io.use(myMiddleware);

  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id, "Type:", socket.type);

    if (socket.type === "client" || socket.type === "human-agent") {
      initializeClientEvents(io, socket);
    } else if (socket.type === "visitor") {
      initializeVisitorEvents(io, socket);
    }

    socket.on("disconnect", () => {
      console.log("User disconnected", socket.id);
    });
  });
};

module.exports = {
  initializeSocketController,
};
