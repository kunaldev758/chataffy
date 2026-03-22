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
  // 4-arg: (userId, agentId, eventName, data) — emit to user-${userId} and/or user-${agentId} when ids are set
  // 3-arg: (roomId, eventName, data) — single room; training-event uses agentId as roomId → user-${agentId} only
  appEvents.on("userEvent", (...args) => {
    if (args.length >= 4) {
      const [userId, agentId, eventName, data] = args;
      if (userId != null && userId !== "") {
        io.to(`user-${userId}`).emit(eventName, data);
      }
      if (agentId != null && agentId !== "") {
        io.to(`user-${agentId}`).emit(eventName, data);
      }
      return;
    }
    if (args.length === 3) {
      const [roomId, eventName, data] = args;
      io.to(`user-${roomId}`).emit(eventName, data);
    }
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
