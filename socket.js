// socket.js
const appEvents = require('./events');
const socketIO = require('socket.io');
const { myMiddleware } = require('./middleware/socketMiddleware');
const { initializeClientEvents } = require('./helpers/clientHandlers');
const { initializeVisitorEvents } = require('./helpers/visitorHandlers');

let io;
// Create a module-level variable to hold the socket controller
let socketController = null;

const initializeSocketController = (server) => {
  io = socketIO(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

   // Listen for events from your controllers
   appEvents.on('userEvent', (userId, eventName, data) => {
    const userRoom = `user-${userId}`;
    io.to(userRoom).emit(eventName, data);
  });

  io.use(myMiddleware);

  io.on('connection', (socket) => {
    console.log('A user connected:', socket.id, 'Type:', socket.type);

    if (socket.type === 'client') {
      initializeClientEvents(io, socket);
    } else if (socket.type === 'visitor') {
      initializeVisitorEvents(io, socket);
    }

    socket.on('disconnect', () => {
      console.log('User disconnected', socket.id);
    });
  });
  

 // Create the controller object
 socketController = {
    emitToUser: (userId, eventName, data) => {
      if (!io) {
        console.error('Socket IO not initialized');
        return false;
      }

      const userRoom = `user-${userId}`;
      io.to(userRoom).emit(eventName, data);
      return true;
    },
    emitToRoom: (room, eventName, data) => {
      if (!io) {
        console.error('Socket IO not initialized');
        return false;
      }

      io.to(room).emit(eventName, data);
      return true;
    },
    emitToAll: (eventName, data) => {
      if (!io) {
        console.error('Socket IO not initialized');
        return false;
      }

      io.emit(eventName, data);
      return true;
    }
  };

  return socketController;
};
// Add a function to get the controller
const getSocketController = () => {
    if (!socketController) {
      console.warn('Socket controller not initialized yet');
      return {
        emitToUser: () => { 
          console.error('Socket not initialized'); 
          return false; 
        },
        emitToRoom: () => { 
          console.error('Socket not initialized'); 
          return false; 
        },
        emitToAll: () => { 
          console.error('Socket not initialized'); 
          return false; 
        }
      };
    }
    return socketController;
  };
  

module.exports = {
  initializeSocketController,
  getSocketController
};