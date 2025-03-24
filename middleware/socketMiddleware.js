// middleware/socketMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Widget = require("../models/Widget");
const Visitor = require("../models/Visitor");
const VisitorController = require("../controllers/VisitorController");

const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded);
      }
    });
  });
};

const myMiddleware = async (socket, next) => {
  try {
    const { token, visitorId, widgetId, widgetAuthToken } =
      socket.handshake.query;

    if (token && !widgetId) {
      // Client Authentication
      const decoded = await verifyToken(token);
      if (!decoded) throw new Error("Invalid token.");

      const user = await User.findById(decoded._id);
      if (!user || user.auth_token !== token)
        throw new Error("User not found or token mismatch.");

      socket.userId = user._id;
      socket.type = "client";


    } else if (visitorId && widgetId && widgetAuthToken) {
      // Visitor Authentication
      const widget = await Widget.findOne({
        _id: widgetId,
        widgetToken: widgetAuthToken,
      });
      if (!widget) throw new Error("Widget authentication failed.");

      socket.userId = widget.userId;
      socket.type = "visitor";

      if (visitorId && visitorId != "undefined") {
        const visitor = await Visitor.findOne({ visitorId: visitorId });
        socket.visitorId =
          visitor && visitor.userId.toString() === socket.userId.toString()
            ? visitor._id
            : (await VisitorController.createVisitor(socket.userId, visitorId))
                ._id;
      } else {
        const visitor = await VisitorController.createVisitor(
          socket.userId,
          visitorId
        );
        socket.visitorId = visitor._id;
      }
    } else {
      throw new Error("Invalid connection type or credentials.");
    }
    next();
  } catch (error) {
    console.error("Socket Middleware Error:", error.message);
    next(new Error("Authentication failed."));
  }
};

module.exports = {
  myMiddleware
};