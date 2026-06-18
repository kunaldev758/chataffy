// handlers/visitorHandlers.js
const { encode } = require("html-entities");
const nodemailer = require("nodemailer");
const ChatMessageController = require("../controllers/ChatMessageController");
const VisitorController = require("../controllers/VisitorController");
const ConversationController = require("../controllers/ConversationController");
const QueryController = require("../controllers/QueryController");
const Widget = require("../models/Widget");
const Visitor = require("../models/Visitor");
const Client = require("../models/Client");
const Conversation = require("../models/Conversation");
const ChatMessage = require("../models/ChatMessage");
const Agent = require("../models/Agent");
const HumanAgent = require("../models/HumanAgent");
const ChatTranscriptSetting = require("../models/ChatTranscriptSetting");
const BlockedVisitorIp = require("../models/blockedVisitorIp");
const NotificationController = require("../controllers/NotificationController");
const { transcriptEmailQueue } = require("../services/jobService");
const { chatTranscriptTemplate } = require("../templates/transcript-template");
const {
  getClientIpFromSocket,
  resolveVisitorGeoForSocket,
} = require("../services/geoService");
const {
  detectHandoffIntent,
  LIVE_CHAT_UNAVAILABLE_MESSAGE,
} = require("../services/HandoffIntentService");
// Store active timeouts for agent connection requests
const agentConnectionTimeouts = new Map();

async function startAgentConnectionFlow(
  io,
  { conversationId, visitorId, userId, agentId, agentRoom },
) {
  const conversationRoom = `conversation-${conversationId}`;
  const visitor = await Visitor.findById(visitorId).lean();

  io.to(conversationRoom).emit("agent-connection-request", {
    conversationId,
    visitorId,
    message: "Connecting to agent...",
  });

  const requestStartedAt = Date.now();
  const agents = await HumanAgent.find({
    assignedAgents: agentId,
    status: "approved",
  }).lean();

  const baseNotificationData = {
    conversationId,
    visitorId,
    agentId,
    visitor,
    message: "Visitor requested to connect to an agent",
    timestamp: new Date(),
    requestStartedAt,
  };

  if (agents.length > 0) {
    for (const agent of agents) {
      const notification =
        await NotificationController.createAgentConnectionNotification(
          agent._id,
          conversationId,
          visitorId,
          userId,
          "Visitor requested to connect to an agent",
          agentId,
        );

      io.to([`user-${agent._id}`]).emit("agent-connection-notification", {
        ...baseNotificationData,
        notificationId: notification?._id,
        humanAgentId: agent._id,
      });
    }
  }

  const timeoutId = setTimeout(async () => {
    const updatedConversation =
      await Conversation.findById(conversationId).lean();
    if (updatedConversation && updatedConversation.aiChat === true) {
      const timeoutMessage = await ChatMessageController.createChatMessage(
        conversationId,
        "",
        "ai",
        "Sorry, currently there is no active agent available. I'll continue helping you.",
        userId,
      );

      io.to(conversationRoom).emit("conversation-append-message", {
        chatMessage: timeoutMessage,
      });
      io.to(conversationRoom).emit("agent-connection-timeout", {
        conversationId,
      });
      agentConnectionTimeouts.delete(conversationId.toString());
    }
  }, 20000);

  agentConnectionTimeouts.set(conversationId.toString(), {
    timeoutId,
    requestStartedAt,
  });
}

async function appendAiReply(io, conversationRoom, conversationId, userId, agentId, text) {
  const html = text.startsWith("<") ? text : `<p>${text}</p>`;
  const chatMessageResponse = await ChatMessageController.createChatMessage(
    conversationId,
    "",
    "ai",
    html,
    userId,
    agentId,
  );
  await chatMessageResponse.populate("agentId", "agentName");
  const chatMessageObj = chatMessageResponse.toObject?.() ?? chatMessageResponse;
  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { lastMessage: stripHtml(text) } },
  );
  io.to(conversationRoom).emit("conversation-append-message", {
    chatMessage: chatMessageObj,
  });
}

const stripHtml = (html) =>
  (html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();

const transcriptMailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, // SMTP server hostname
  port: Number(process.env.SMTP_PORT), // Port for the SMTP server (587 for TLS, 465 for SSL)
  secure: false, // Set to true if using SSL
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD,
  },
});

const isValidTimezone = (timezone) => {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const formatTimestamp = (dateValue, timeZone = "UTC") => {
  if (!dateValue) return "-";
  const safeTimeZone = isValidTimezone(timeZone) ? timeZone : "UTC";
  try {
    return new Date(dateValue).toLocaleString("en-US", {
      timeZone: safeTimeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return new Date(dateValue).toLocaleString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }
};

const formatDuration = (start, end) => {
  if (!start || !end) return "-";
  const diffMs = Math.max(
    0,
    new Date(end).getTime() - new Date(start).getTime(),
  );
  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const getVisitorEmail = (visitorDoc) => {
  if (!visitorDoc?.visitorDetails?.length) return "N/A";
  const emailField = visitorDoc.visitorDetails.find((item) => {
    const key = String(item?.field || "").toLowerCase();
    return key.includes("email");
  });
  return emailField?.value || "N/A";
};

const getMessageSenderName = (msg, visitorName = "Visitor") => {
  const senderType = msg?.sender_type || "system";
  const humanAgentName = msg?.humanAgentId?.name;
  const agentName = msg?.agentId?.agentName;

  if (senderType === "visitor") return visitorName || "Visitor";
  if (senderType === "humanAgent" || senderType === "client") {
    return humanAgentName || agentName || "Agent";
  }

  return (
    (senderType === "ai" ? "AI Assistant" : null) ||
    (senderType === "system" ? "System" : null) ||
    humanAgentName ||
    agentName ||
    msg?.sender ||
    senderType ||
    "System"
  );
};

const sendConversationTranscriptEmail = async (conversation) => {
  console.log(conversation, "<----------- conversation");
  if (!conversation?.userId || !conversation?._id) return;
  const transcriptSettings = await ChatTranscriptSetting.findOne({
    userId: conversation.userId,
  }).lean();
  const recipients = transcriptSettings?.transcriptEmails || [];
  console.log(recipients, "<----------- recipients");
  if (!recipients || !recipients.length) {
    console.log("NO transcriptEmails found returning");
    return;
  }

  const [visitorDoc, messages, widget] = await Promise.all([
    Visitor.findById(conversation.visitor).lean(),
    ChatMessage.find({
      conversation_id: conversation._id,
      is_note: { $ne: true },
      sender_type: { $ne: "agent-connect" },
    })
      .sort({ createdAt: 1 })
      .populate("humanAgentId", "name")
      .populate("agentId", "agentName")
      .populate({
        path: "replyTo",
        select: "sender message createdAt sender_type humanAgentId agentId",
        populate: [
          { path: "humanAgentId", select: "name" },
          { path: "agentId", select: "agentName" },
        ],
      })
      .lean(),
    Widget.findOne({
      userId: conversation.userId,
      agentId: conversation.agentId,
    })
      .select("titleBar colorFields settings")
      .lean(),
  ]);
  const widgetTimezone =
    widget?.settings?.timezone ||
    widget?.settings?.workingHours?.timezone ||
    "UTC";
  const visitorName = visitorDoc?.name || "Visitor";
  const firstMessageAt = messages?.[1]?.createdAt || conversation.createdAt;
  const lastMessageAt =
    messages?.[messages.length - 1]?.createdAt ||
    conversation.endedAt ||
    conversation.updatedAt ||
    new Date();

  const mappedMessages = messages
    //  .filter((msg) => msg?.sender_type !== "agent-connect" && typeof msg?.is_note === "string" ? msg?.is_note !== "true" : msg?.is_note !== true)
    .map((msg) => {
      const senderType = msg?.sender_type || "system";
      const senderName = getMessageSenderName(msg, visitorName);
      const replyTo = msg?.replyTo
        ? {
            sender: getMessageSenderName(msg.replyTo, visitorName),
            sender_type: msg.replyTo?.sender_type || "system",
            timestamp: formatTimestamp(msg.replyTo?.createdAt, widgetTimezone),
            text: stripHtml(msg.replyTo?.message || ""),
          }
        : null;

      return {
        sender: senderName,
        sender_type: senderType,
        timestamp: formatTimestamp(msg?.createdAt, widgetTimezone),
        text: stripHtml(msg?.message || ""),
        replyTo,
      };
    });

  const html = chatTranscriptTemplate({
    websiteName: widget?.titleBar || "Chataffy",
    conversationId: conversation._id.toString(),
    visitorName,
    visitorEmail: getVisitorEmail(visitorDoc),
    startedAt: formatTimestamp(firstMessageAt, widgetTimezone),
    endedAt: formatTimestamp(lastMessageAt, widgetTimezone),
    duration: formatDuration(firstMessageAt, lastMessageAt),
    messages: mappedMessages,
    colorFields: widget?.colorFields || [],
    timezone: widgetTimezone,
  });

  const appName = process.env.APP_NAME || "Chataffy";
  const result = await Promise.allSettled(
    recipients.map((email) =>
      transcriptMailTransporter.sendMail({
        from: `${appName} <${process.env.SMTP_FROM}>`,
        to: email,
        subject: `Chat Transcript`,
        html,
      }),
    ),
  );

  const rejected = result.filter((result) => result.status === "rejected");
  if (rejected.length > 0) {
    console.error("Transcript email rejected:", rejected);
  }

  // retry to send the failed emails
};

// Export for use in other handlers
module.exports.agentConnectionTimeouts = agentConnectionTimeouts;

function isLocalIp(ip) {
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.");
}

const initializeVisitorEvents = (io, socket) => {
  const { humanAgentId } = socket;
  const { userId } = socket;
  const { visitorId } = socket;
  const { agentId } = socket;
  const { type } = socket;
  // let userAgentRoom = "";
  // let userRoom = "";
  let visitorRoom = "";
  let agentRoom = "";
  let conversationRoom = "";

  console.log(agentId, "<----------- agentId");

  // userAgentRoom = `user-${agentId}-${humanAgentId}`;
  agentRoom = `user-${agentId}`;
  visitorRoom = `visitor-${agentId}-${visitorId}`;
  // userRoom = `user-${userId}`;
  socket.join(visitorRoom);
  socket.join(agentRoom);
  // socket.join(userRoom);

  const checkVisitorBlocked = async (ip) => {
    if (!ip) return;
    const ipFound = await BlockedVisitorIp.findOne({
      ip,
      userId,
    });
    if (ipFound) {
      io.to(visitorRoom).emit("visitor-is-blocked", {});
    }
  };

  const resolveAndSaveVisitorGeo = async () => {
    try {
      let geo = await resolveVisitorGeoForSocket(socket);

      console.log("Resolved visitor geo:", geo);

      if (isLocalIp(geo.ip)) {
        geo.country = "IN";
      }

      if (!visitorId) return geo;

      await VisitorController.updateVisitorById({
        id: visitorId,
        location: geo.country,
        ip: geo.ip,
      });

      socket.emit("visitor-geo-resolved", {
        ip: geo.ip,
        country: geo.country,
      });

      await checkVisitorBlocked(geo.ip);
      return geo;
    } catch (error) {
      console.error("resolveAndSaveVisitorGeo error:", error.message);
      return null;
    }
  };

  resolveAndSaveVisitorGeo();

  socket.on("visitor-ip", async (_payload, callback) => {
    try {
      const ip = getClientIpFromSocket(socket);
      await checkVisitorBlocked(ip);
      callback?.({ success: true, ip });
    } catch (error) {
      console.error("visitor-ip error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("visitor-connect", async ({ widgetToken }) => {
    try {
      const themeSettings = await Widget.findOne({ widgetToken });
      if (!themeSettings) {
        socket.emit("error", { message: "Widget not found" });
        return;
      }
      // Use agentId from URL/query, fallback to Widget's agentId (multi-agent support)
      const effectiveAgentId = agentId || themeSettings.agentId;
      const ownerUserId = userId || themeSettings.userId;

      // Open or create one conversation per widget session; limit applies only when creating a new thread.
      let conversation = await ConversationController.getOpenConversation(
        visitorId,
        ownerUserId,
        effectiveAgentId,
      );

      if (!conversation) {
        await Client.updateOne(
          { userId: ownerUserId },
          { $set: { "upgradePlanStatus.chatLimitExceeded": true } },
        );
        socket.emit("visitor-connect-response", {
          conversationId: null,
          chatMessages: [],
          themeSettings,
          aiChat: true,
          conversationFeedback: null,
          isLimitExpired: true,
        });
        return;
      }

      const isLimitExpired = false;

      // Fetch the visitor's conversation history
      let chatMessages = [];
      chatMessages = await ChatMessageController.getAllChatMessages(
        visitorId,
        effectiveAgentId,
      );

      let aiChat = true;

      if (chatMessages.length <= 0) {
        const conversationId = conversation?._id || null;

        await ChatMessageController.createChatMessage(
          conversationId,
          visitorId,
          "system",
          themeSettings?.welcomeMessage,
          ownerUserId,
          effectiveAgentId,
        );

        chatMessages = await ChatMessageController.getAllChatMessages(
          visitorId,
          effectiveAgentId,
        );
      }

      // aiChat from loaded conversation
      aiChat = conversation.aiChat !== undefined ? conversation.aiChat : true;
      console.log(
        "🔌 visitor-connect: aiChat status:",
        aiChat,
        "for conversation:",
        conversation._id,
      );

      // Prepare conversation feedback data
      const conversationFeedback = conversation
        ? {
            feedback: conversation.feedback,
            comment: conversation.comment,
          }
        : null;

      conversationRoom = `conversation-${conversation._id}`;
      socket.join(conversationRoom);

      // Emit visitor-connect-response directly to the visitor.
      // socket.to(room) EXCLUDES the sender — the visitor would never receive it.
      io.to(conversationRoom).emit("visitor-connect-response", {
        conversationId: conversation._id,
        chatMessages,
        themeSettings,
        aiChat: aiChat,
        conversationFeedback: conversationFeedback,
        isLimitExpired,
      });
    } catch (error) {
      console.error("Error handling visitor-connect:", error);
      socket.emit("error", { message: "Failed to connect visitor" });
    }
  });

  socket.on("save-visitor-details", async ({ visitorDetails }, callback) => {
    try {
      const geo = await resolveVisitorGeoForSocket(socket);
      await VisitorController.updateVisitorById({
        id: visitorId,
        location: geo.country,
        ip: geo.ip,
        visitorDetails,
      });
      callback?.({ success: true, ip: geo.ip, country: geo.country });
    } catch (error) {
      console.error("save-visitor-details error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on(
    "visitor-send-message",
    async ({ message, id, replyTo }, callback) => {
      try {
        const conversation = await ConversationController.getOpenConversation(
          visitorId,
          userId,
          agentId,
          // socket.humanAgentId
        );
        if (!conversation) {
          await Client.updateOne(
            { userId },
            { $set: { "upgradePlanStatus.chatLimitExceeded": true } },
          );
          socket.emit("visitor-connect-response-upgrade");
          callback?.({ success: false });
          return;
        }
        const conversationId = conversation._id;
        const messages = await ChatMessage.find({
          conversation_id: conversationId,
        });
        if (messages.length <= 1) {
          await Conversation.findByIdAndUpdate(conversationId, {
            is_started: true,
          });
          io.to([agentRoom]).emit("visitor-connect-list-update", {});
        }
        const encodedMessage = encode(message);
        let chatMessage = await ChatMessageController.createChatMessage(
          conversationId,
          visitorId,
          "visitor",
          "<p>" + encodedMessage + "</p>",
          userId,
          agentId,
          undefined,
          undefined,
          replyTo,
        );

        if (replyTo) {
          await chatMessage.populate({
            path: "replyTo",
            select: "sender message createdAt sender_type humanAgentId agentId",
            populate: [
              { path: "humanAgentId", select: "name isClient" },
              { path: "agentId", select: "agentName" },
            ],
          });
        }

        const chatMessageObj = chatMessage.toObject
          ? chatMessage.toObject()
          : chatMessage;

        io.to(conversationRoom).emit("conversation-append-message", {
          chatMessage: chatMessageObj,
        });
        await Conversation.updateOne(
          { _id: conversationId },
          { $inc: { newMessage: 1 }, $set: { lastMessage: message } },
        );
        io.to([agentRoom]).emit("new-message-count", {
          conversationId,
          lastMessage: message,
        });
        callback?.({ success: true, chatMessage: chatMessageObj, id });
        if (conversation.aiChat) {
          const convRoom = conversationRoom || `conversation-${conversationId}`;

          const recentMessages = await ChatMessage.find({
            conversation_id: conversationId,
          })
            .sort({ createdAt: -1 })
            .limit(8)
            .select("sender_type message")
            .lean();
          recentMessages.reverse();

          const intent = await detectHandoffIntent(message, recentMessages, {
            userId,
            agentId,
          });

          io.to(convRoom).emit("intermediate-response", {
            message: "...replying",
            conversationId,
          });

          if (intent.isHandoff) {
            const agentData = await Agent.findOne({ _id: agentId })
              .select("liveAgentSupport")
              .lean();
            if (agentData?.liveAgentSupport === true) {
              await startAgentConnectionFlow(io, {
                conversationId,
                visitorId,
                userId,
                agentId,
                agentRoom,
              });
              return;
            }
            await appendAiReply(
              io,
              convRoom,
              conversationId,
              userId,
              agentId,
              LIVE_CHAT_UNAVAILABLE_MESSAGE,
            );
            return;
          }

          if (intent.needsClarification) {
            await appendAiReply(
              io,
              convRoom,
              conversationId,
              userId,
              agentId,
              intent.clarifierMessage,
            );
            return;
          }

          const response_data = await QueryController.handleQuestionAnswer(
            userId,
            agentId,
            message,
            conversationId,
          );

          if (response_data.isAgentRequest) {
            const agentData = await Agent.findOne({ _id: agentId })
              .select("liveAgentSupport")
              .lean();
            if (agentData?.liveAgentSupport === true) {
              await startAgentConnectionFlow(io, {
                conversationId,
                visitorId,
                userId,
                agentId,
                agentRoom,
              });
              return;
            }
            await appendAiReply(
              io,
              convRoom,
              conversationId,
              userId,
              agentId,
              LIVE_CHAT_UNAVAILABLE_MESSAGE,
            );
            return;
          }

          if (response_data.success == true) {
            const chatMessageResponse =
              await ChatMessageController.createChatMessage(
                conversationId,
                "",
                "ai",
                response_data.answer,
                userId,
                agentId,
                response_data?.sources,
              );
            await chatMessageResponse.populate("agentId", "agentName");
            const chatMessageObj =
              chatMessageResponse.toObject?.() ?? chatMessageResponse;
            await Conversation.updateOne(
              { _id: conversationId },
              { $set: { lastMessage: stripHtml(response_data.answer) } },
            );
            io.to(conversationRoom).emit("conversation-append-message", {
              chatMessage: chatMessageObj,
              sources: response_data?.sources,
            });
          } else {
            const agentFallback = await Agent.findById(agentId)
              .select("fallbackMessage")
              .lean();
            const fallbackText =
              (agentFallback?.fallbackMessage &&
                String(agentFallback.fallbackMessage).trim()) ||
              "error in generating Response";
            const chatMessageResponse =
              await ChatMessageController.createChatMessage(
                conversationId,
                "",
                "system",
                fallbackText,
                userId,
                agentId,
              );
            await Conversation.updateOne(
              { _id: conversationId },
              { $set: { lastMessage: stripHtml(fallbackText) } },
            );
            io.to(conversationRoom).emit("conversation-append-message", {
              chatMessage: chatMessageResponse,
            });
          }
        }
      } catch (error) {
        console.error("visitor-send-message error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    },
  );

  socket.on(
    "conversation-feedback",
    async ({ conversationId, feedback, comment }, callback) => {
      try {
        await ConversationController.updateFeedback(
          conversationId,
          feedback,
          comment,
        );
        callback?.({ success: true });

        // Build the conversation room from the payload so we don't depend on the
        // closure variable (which is only set after visitor-connect fires).
        const feedbackConvRoom = `conversation-${conversationId}`;
        const rooms = [agentRoom, feedbackConvRoom].filter(Boolean);
        console.log(
          `[conversation-feedback] emitting conversation-feedback-update to rooms:`,
          rooms,
          { conversationId, feedback, comment },
        );
        io.to(rooms).emit("conversation-feedback-update", {
          conversationId,
          feedback,
          comment,
        });
      } catch (error) {
        console.error("message-feedback error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    },
  );

  socket.on(
    "close-conversation-visitor",
    async ({ conversationId }, callback) => {
      try {
        let closedByName = "Visitor";
        try {
          const visitorDoc = await Visitor.findById(socket.visitorId).lean();
          if (visitorDoc?.name) closedByName = visitorDoc.name;
        } catch (_) {
          /* keep default */
        }

        // Only mark the conversation as visitor-closed.
        // conversationOpenStatus intentionally stays "open" so the conversation
        // remains visible in the agent's inbox. Only a human agent can truly close it.
        await ConversationController.markVisitorClosed(conversationId);

        const conversation = await Conversation.findById(conversationId).lean();

        if (conversation) {
          const closeLine = await ChatMessageController.createChatMessage(
            conversationId,
            conversation.visitor,
            "agent-connect",
            `Chat ended: ${closedByName} closed the chat.`,
            conversation.userId,
            conversation.agentId || agentId,
          );
          const closeLineObj = closeLine.toObject
            ? closeLine.toObject()
            : closeLine;
          io.to(`conversation-${conversationId}`).emit(
            "conversation-append-message",
            {
              chatMessage: closeLineObj,
            },
          );
          try {
            await transcriptEmailQueue.add("sendConversationTranscriptEmail", {
              conversation,
            });
          } catch (mailError) {
            console.error("queue transcript email error:", mailError.message);
          }
        }

        callback?.({ success: true });

        if (conversation) {
          // Notify visitor side that chat is closed (UI shows closed state).
          // Also notify agent room so they see the system message and visitor status update.
          io.to([agentRoom, conversationRoom]).emit("visitor-close-chat", {
            conversationStatus: "close",
          });
        }
      } catch (error) {
        console.error("close-conversation-visitor error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    },
  );

  // Listen for agent connection accepted to clear timeout
  socket.on("agent-connection-accepted-clear-timeout", ({ conversationId }) => {
    const entry = agentConnectionTimeouts.get(conversationId?.toString());
    if (entry?.timeoutId) {
      clearTimeout(entry.timeoutId);
      agentConnectionTimeouts.delete(conversationId?.toString());
      console.log(`Cleared timeout for conversation ${conversationId}`);
    }
  });

  socket.on("disconnect", () => {
    socket.leave(visitorRoom);
    socket.leave(conversationRoom);
    socket.leave(agentRoom);
    // socket.leave(userAgentRoom);
    // socket.leave(userRoom);
  });
};

module.exports = {
  initializeVisitorEvents,
  agentConnectionTimeouts,
  sendConversationTranscriptEmail,
};
