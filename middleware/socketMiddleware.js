// // middleware/socketMiddleware.js
// const jwt = require("jsonwebtoken");
// const User = require("../models/User");
// const Widget = require("../models/Widget");
// const Visitor = require("../models/Visitor");
// const VisitorController = require("../controllers/VisitorController");
// const Agent = require("../models/Agent");
// const HumanAgent = require("../models/HumanAgent");

// const verifyToken = (token) => {
//   return new Promise((resolve, reject) => {
//     jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
//       if (err) reject(err);
//       else resolve(decoded);
//     });
//   });
// };

// async function resolveHumanAgentForSocket(decoded, humanAgentIdFromQuery) {
//   const isHumanAgentJwt = decoded?.role === "human-agent";
//   const queryId = humanAgentIdFromQuery || null;

//   console.log("Resolving human agent for socket connection...");
//   console.log("Decoded JWT:", decoded);
//   console.log("Human Agent ID from query:", queryId);

//   if (queryId) {
//     const fromQuery = await HumanAgent.findOne({
//       _id: queryId,
//       isDeleted: { $ne: true },
//     });
//     if (fromQuery) return fromQuery;
//   }

//   if (isHumanAgentJwt && decoded?.id) {
//     const fromJwt = await HumanAgent.findOne({
//       _id: decoded.id,
//       isDeleted: { $ne: true },
//     });
//     if (fromJwt) return fromJwt;
//   }

//   if (decoded?._id) {
//     const clientRecord = await HumanAgent.findOne({
//       userId: decoded._id,
//       isClient: true,
//       isDeleted: { $ne: true },
//     });
//     if (clientRecord) return clientRecord;
//   }

//   return null;
// }

// const myMiddleware = async (socket, next) => {
//   try {
//     const { token, visitorId, widgetId, widgetAuthToken, agentId, humanAgentId } =
//       socket.handshake.query;

//     console.log("Socket connection attempt with query:", socket.handshake.query);
//     const authToken = typeof token === "string" ? token.trim() : "";

//     if (authToken && !widgetId) {
//       const decoded = await verifyToken(authToken);
//       if (!decoded) throw new Error("Invalid token.");

//       console.log("check human agent Id : ",humanAgentId);

//       const humanAgent = await resolveHumanAgentForSocket(decoded, humanAgentId);
//       if (!humanAgent) {
//         throw new Error("Human agent not found.");
//       }

//       if (humanAgent.isClient) {
//         socket.userId = humanAgent.userId;
//         socket.type = "client";
//         socket.humanAgentId = humanAgent._id.toString();

//         const userId = decoded._id || humanAgent.userId;
//         const user = await User.findById(userId);
//         const socketPlatform = decoded?.platform || "local";
//         const socketTokenField =
//           socketPlatform === "shopify"
//             ? "sf_token"
//             : socketPlatform === "bigcommerce"
//               ? "bc_token"
//               : "auth_token";

//         if (!user || user[socketTokenField] !== authToken) {
//           throw new Error("User not found or token mismatch.");
//         }
//       } else {
//         socket.userId = humanAgent.userId;
//         socket.type = "human-agent";
//         socket.humanAgentId = humanAgent._id.toString();
//       }

//       socket.agentId = agentId || undefined;

//       if (!socket.agentId && socket.userId) {
//         if (humanAgent.assignedAgents?.length > 0) {
//           socket.agentId = humanAgent.assignedAgents[0].toString();
//         } else {
//           const firstAgent = await Agent.findOne({
//             userId: socket.userId,
//             isDeleted: { $ne: true },
//           }).lean();
//           if (firstAgent) socket.agentId = firstAgent._id.toString();
//         }
//       }
//     } else if (visitorId && widgetId && widgetAuthToken) {
//       const widget = await Widget.findOne({
//         _id: widgetId,
//         widgetToken: widgetAuthToken,
//       });
//       if (!widget) throw new Error("Widget authentication failed.");

//       socket.userId = widget.userId;
//       socket.type = "visitor";
//       socket.agentId = agentId || widget.agentId;
//       socket.humanAgentId = humanAgentId;

//       if (visitorId && visitorId != "undefined") {
//         const visitor = await Visitor.findOne({ visitorId: visitorId });
//         socket.visitorId =
//           visitor && visitor.userId.toString() === socket.userId.toString()
//             ? visitor._id
//             : (
//                 await VisitorController.createVisitor(
//                   socket.userId,
//                   socket.agentId,
//                   visitorId,
//                 )
//               )._id;
//       } else {
//         const visitor = await VisitorController.createVisitor(
//           socket.userId,
//           socket.agentId,
//           visitorId,
//         );
//         socket.visitorId = visitor._id;
//       }
//     } else {
//       throw new Error("Invalid connection type or credentials.");
//     }
//     next();
//   } catch (error) {
//     console.error("Socket Middleware Error:", error.message);
//     next(new Error("Authentication failed."));
//   }
// };

// module.exports = {
//   myMiddleware,
// };



// middleware/socketMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Widget = require("../models/Widget");
const Visitor = require("../models/Visitor");
const VisitorController = require("../controllers/VisitorController");
const Agent = require("../models/Agent");
const HumanAgent = require("../models/HumanAgent");

const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded);
    });
  });
};

async function resolveHumanAgentForSocket(decoded, humanAgentIdFromQuery) {
  const isHumanAgentJwt = decoded?.role === "human-agent";
  const queryId = humanAgentIdFromQuery && humanAgentIdFromQuery !== "undefined" ? humanAgentIdFromQuery : null;

  if (queryId) {
    const fromQuery = await HumanAgent.findOne({
      _id: queryId,
      isDeleted: { $ne: true },
    });
    if (fromQuery) return fromQuery;
  }

  if (isHumanAgentJwt && decoded?.id) {
    const fromJwt = await HumanAgent.findOne({
      _id: decoded.id,
      isDeleted: { $ne: true },
    });
    if (fromJwt) return fromJwt;
  }

  if (decoded?._id) {
    const clientRecord = await HumanAgent.findOne({
      userId: decoded._id,
      isClient: true,
      isDeleted: { $ne: true },
    });
    if (clientRecord) return clientRecord;
  }

  return null;
}

const myMiddleware = async (socket, next) => {
  try {
    const { token, visitorId, widgetId, widgetAuthToken, agentId, humanAgentId } =
      socket.handshake.query;

    const authToken = typeof token === "string" ? token.trim() : "";

    if (authToken && !widgetId) {
      const decoded = await verifyToken(authToken);
      if (!decoded) throw new Error("Invalid token.");

      const humanAgent = await resolveHumanAgentForSocket(decoded, humanAgentId);
      
      // For first-time login, user may not have a HumanAgent record yet
      if (!humanAgent) {
        const userId = decoded._id;
        const user = await User.findById(userId);
        
        if (!user) {
          throw new Error("User not found.");
        }

        const socketPlatform = decoded?.platform || "local";
        const socketTokenField =
          socketPlatform === "shopify"
            ? "sf_token"
            : socketPlatform === "bigcommerce"
              ? "bc_token"
              : "auth_token";

        if (user[socketTokenField] !== authToken) {
          throw new Error("Token mismatch.");
        }

        // First-time login: set socket properties for authenticated user without HumanAgent
        socket.userId = userId;
        socket.type = "client";
        socket.humanAgentId = undefined;
        socket.agentId = agentId || undefined;

        // Try to find or assign an agent
        if (!socket.agentId && socket.userId) {
          const firstAgent = await Agent.findOne({
            userId: socket.userId,
            isDeleted: { $ne: true },
          }).lean();
          if (firstAgent) socket.agentId = firstAgent._id.toString();
        }
      } else if (humanAgent.isClient) {
        socket.userId = humanAgent.userId;
        socket.type = "client";
        socket.humanAgentId = humanAgent._id.toString();

        const userId = decoded._id || humanAgent.userId;
        const user = await User.findById(userId);
        const socketPlatform = decoded?.platform || "local";
        const socketTokenField =
          socketPlatform === "shopify"
            ? "sf_token"
            : socketPlatform === "bigcommerce"
              ? "bc_token"
              : "auth_token";

        if (!user || user[socketTokenField] !== authToken) {
          throw new Error("User not found or token mismatch.");
        }

        socket.agentId = agentId || undefined;

        if (!socket.agentId && socket.userId) {
          if (humanAgent.assignedAgents?.length > 0) {
            socket.agentId = humanAgent.assignedAgents[0].toString();
          } else {
            const firstAgent = await Agent.findOne({
              userId: socket.userId,
              isDeleted: { $ne: true },
            }).lean();
            if (firstAgent) socket.agentId = firstAgent._id.toString();
          }
        }
      } else {
        socket.userId = humanAgent.userId;
        socket.type = "human-agent";
        socket.humanAgentId = humanAgent._id.toString();
        socket.agentId = agentId || undefined;
      }
    } else if (visitorId && widgetId && widgetAuthToken) {
      const widget = await Widget.findOne({
        _id: widgetId,
        widgetToken: widgetAuthToken,
      });
      if (!widget) throw new Error("Widget authentication failed.");

      socket.userId = widget.userId;
      socket.type = "visitor";
      socket.agentId = agentId || widget.agentId;
      socket.humanAgentId = humanAgentId;

      if (visitorId && visitorId != "undefined") {
        const visitor = await Visitor.findOne({ visitorId: visitorId });
        socket.visitorId =
          visitor && visitor.userId.toString() === socket.userId.toString()
            ? visitor._id
            : (
                await VisitorController.createVisitor(
                  socket.userId,
                  socket.agentId,
                  visitorId,
                )
              )._id;
      } else {
        const visitor = await VisitorController.createVisitor(
          socket.userId,
          socket.agentId,
          visitorId,
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
  myMiddleware,
};
