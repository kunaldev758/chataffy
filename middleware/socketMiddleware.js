// middleware/socketMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Widget = require("../models/Widget");
const Visitor = require("../models/Visitor");
const VisitorController = require("../controllers/VisitorController");
const Agent = require('../models/Agent');
const HumanAgent = require('../models/HumanAgent');

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
    const { token, visitorId, widgetId, widgetAuthToken,agentId,humanAgentId } =
      socket.handshake.query;

    if (token && !widgetId) {
      // Client or Human Agent Authentication
      const decoded = await verifyToken(token);
      if (!decoded) throw new Error("Invalid token.");

      const isHumanAgentLogin = decoded.role === "human-agent";
      const resolvedHumanAgentId = humanAgentId || (isHumanAgentLogin ? decoded.id : null);

      const humanAgent = resolvedHumanAgentId
        ? await HumanAgent.findById(resolvedHumanAgentId)
        : null;

      if (!humanAgent) {
        throw new Error("Human agent not found.");
      }

      if (humanAgent.isClient) {
        socket.userId = humanAgent.userId;
        socket.type = "client";
        socket.agentId = agentId;
        socket.humanAgentId = humanAgent.id;
        const user = await User.findById(decoded._id);
        if (!user || user.auth_token !== token) {
          throw new Error("User not found or token mismatch.");
        }
      } else {
        socket.userId = humanAgent.userId;
        socket.type = "human-agent";
        socket.agentId = agentId;
        socket.humanAgentId = humanAgent.id;
      }

      // Fallback: when agentId not in query, use first assigned agent or first Agent for this user
      if (!socket.agentId && socket.userId) {
        if (humanAgent.assignedAgents?.length > 0) {
          socket.agentId = humanAgent.assignedAgents[0];
        } else {
          const firstAgent = await Agent.findOne({ userId: socket.userId }).lean();
          if (firstAgent) socket.agentId = firstAgent._id;
        }
      }
    } else if (visitorId && widgetId && widgetAuthToken) {
      // Visitor Authentication
      const widget = await Widget.findOne({
        _id: widgetId,
        widgetToken: widgetAuthToken,
      });
      if (!widget) throw new Error("Widget authentication failed.");

      socket.userId = widget.userId;
      socket.type = "visitor";
      // Use agentId from query, fallback to Widget's agentId (for 2-segment widget URLs)
      socket.agentId = agentId || widget.agentId;
      socket.humanAgentId = humanAgentId;

      if (visitorId && visitorId != "undefined") {
        const visitor = await Visitor.findOne({ visitorId: visitorId });
        socket.visitorId =
          visitor && visitor.userId.toString() === socket.userId.toString()
            ? visitor._id
            : (await VisitorController.createVisitor(socket.userId, socket.agentId, visitorId))
                ._id;
      } else {
        const visitor = await VisitorController.createVisitor(
          socket.userId,
          socket.agentId,
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