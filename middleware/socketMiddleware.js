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
const ImpersonationSession = require("../models/ImpersonationSession");
const UserSession = require("../models/userSession");

const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
      if (err) reject(err);
      else resolve(decoded);
    });
  });
};

const getQueryValue = (value) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

/** Query params often arrive as the literal strings "undefined" / "null". */
const normalizeOptionalId = (value) => {
  const v = getQueryValue(value);
  if (!v || v === "undefined" || v === "null") return undefined;
  return v;
};

async function resolveHumanAgentForSocket(decoded, humanAgentIdFromQuery) {
  const queryId = getQueryValue(humanAgentIdFromQuery);

  if (queryId && queryId !== "undefined" && queryId !== "null") {
    const fromQuery = await HumanAgent.findOne({
      _id: queryId,
      isDeleted: { $ne: true },
    });
    if (fromQuery) return fromQuery;
  }

  const isHumanAgentJwt = decoded?.role === "human-agent";
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

async function findAgentIdForUser(userId, explicitAgentId) {
  const agentId = normalizeOptionalId(explicitAgentId);
  if (agentId) return agentId;

  const firstAgent = await Agent.findOne({
    userId,
    isDeleted: { $ne: true },
  }).lean();

  return firstAgent ? firstAgent._id.toString() : undefined;
}

async function validateClientSession(token, decoded) {
  if (!decoded?._id) return null;

  const platform = decoded?.platform || "local";
  const session = await UserSession.findOne({
    userId: decoded._id,
    platform,
    token,
  });

  if (!session) return null;
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) return null;

  return {
    userId: decoded._id,
    platform,
    session,
  };
}

async function validateImpersonationToken(decoded) {
  if (decoded?.purpose !== "impersonation" || !decoded?._id || !decoded?.jti) {
    return null;
  }

  const session = await ImpersonationSession.findOne({ jti: decoded.jti });
  if (!session || session.revokedAt) return null;
  if (String(session.userId) !== String(decoded._id)) return null;
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) return null;

  return session;
}

const myMiddleware = async (socket, next) => {
  try {
    const query = socket.handshake.query;
    const token = getQueryValue(query.token);
    const visitorId = getQueryValue(query.visitorId);
    const widgetId = getQueryValue(query.widgetId);
    const widgetAuthToken = getQueryValue(query.widgetAuthToken);
    const agentId = normalizeOptionalId(query.agentId);
    const humanAgentId = normalizeOptionalId(query.humanAgentId);

    const authToken = typeof token === "string" ? token.trim() : "";

    if (authToken && !widgetId) {
      const decoded = await verifyToken(authToken);
      if (!decoded) throw new Error("Invalid token.");

      const impersonationSession = await validateImpersonationToken(decoded);
      if (impersonationSession) {
        socket.userId = decoded._id;
        socket.type = "client";
        socket.humanAgentId = undefined;
        socket.impersonatedBy = impersonationSession.superAdminId;
        socket.authSession = {
          portal: "client",
          platform: "local",
          token: authToken,
        };
        socket.agentId = await findAgentIdForUser(socket.userId, agentId);
        return next();
      }

      const humanAgent = await resolveHumanAgentForSocket(decoded, humanAgentId);
      const isHumanAgentToken =
        decoded?.id && humanAgent && String(decoded.id) === String(humanAgent._id);

      if (isHumanAgentToken) {
        socket.userId = humanAgent.userId;
        socket.type = "human-agent";
        socket.humanAgentId = humanAgent._id.toString();
        socket.agentId = agentId;
        if (!socket.agentId && humanAgent.assignedAgents?.length > 0) {
          socket.agentId = humanAgent.assignedAgents[0].toString();
        }
        if (!socket.agentId) {
          socket.agentId = await findAgentIdForUser(socket.userId, agentId);
        }
        socket.authSession = { portal: "agent", token: authToken };
      } else {
        const clientSession = await validateClientSession(authToken, decoded);
        if (!clientSession) {
          throw new Error("Client session invalid or expired.");
        }

        socket.userId = clientSession.userId;
        socket.type = "client";
        socket.authSession = {
          portal: "client",
          platform: clientSession.platform,
          token: authToken,
          sessionId: clientSession.session._id,
        };

        if (humanAgent && humanAgent.isClient) {
          socket.humanAgentId = humanAgent._id.toString();
          socket.agentId = agentId;
          if (!socket.agentId && humanAgent.assignedAgents?.length > 0) {
            socket.agentId = humanAgent.assignedAgents[0].toString();
          }
          if (!socket.agentId) {
            socket.agentId = await findAgentIdForUser(socket.userId, agentId);
          }
        } else {
          socket.humanAgentId = undefined;
          socket.agentId = await findAgentIdForUser(socket.userId, agentId);
        }
      }
    } else if (visitorId && widgetId && widgetAuthToken) {
      const widget = await Widget.findOne({
        _id: widgetId,
        widgetToken: widgetAuthToken,
      });
      if (!widget) throw new Error("Widget authentication failed.");

      socket.userId = widget.userId;
      socket.type = "visitor";
      socket.agentId =
        agentId ||
        widget.agentId?.toString?.() ||
        widget.agentId;
      socket.humanAgentId = humanAgentId;

      if (visitorId !== undefined && visitorId !== "undefined") {
        const visitor = await Visitor.findOne({ visitorId });
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
