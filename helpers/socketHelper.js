// helpers/socketHelper.js
const emitSocketEvent = (io, userId, eventName, data) => {
    io.to(`user${userId}`).emit(eventName, data);
  };
  
  module.exports = { emitSocketEvent };