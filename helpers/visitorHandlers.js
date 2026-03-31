// handlers/visitorHandlers.js
const { encode } = require("html-entities");
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
const BlockedVisitorIp = require("../models/blockedVisitorIp");
const NotificationController = require("../controllers/NotificationController");
const { checkPlanLimits } = require("../services/PlanService");

// Store active timeouts for agent connection requests
const agentConnectionTimeouts = new Map();

const stripHtml = (html) => (html || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

// Export for use in other handlers
module.exports.agentConnectionTimeouts = agentConnectionTimeouts;

const initializeVisitorEvents = (io, socket) => {
  const { humanAgentId } = socket;
  const { userId } = socket;
  const { visitorId } = socket;
  const { agentId } = socket;
  const {type} = socket;
  // let userAgentRoom = "";
  // let userRoom = "";
  let visitorRoom = "";
  let agentRoom = "";
  let conversationRoom = "";

    // userAgentRoom = `user-${agentId}-${humanAgentId}`;
    agentRoom = `user-${agentId}`;
    visitorRoom = `visitor-${agentId}-${visitorId}`;
    // userRoom = `user-${userId}`;
  socket.join(visitorRoom);
  socket.join(agentRoom);
  // socket.join(userRoom);

  socket.on("visitor-ip", async ({ ip }, callback) => {
    try {
      const ipFound = await BlockedVisitorIp.findOne({
        ip: ip,
        userId: userId,
      });
      if (ipFound) {
        io.to(visitorRoom).emit("visitor-is-blocked", {});
      }
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

      // Fetch the visitor's conversation history
      let chatMessages = [];
      chatMessages = await ChatMessageController.getAllChatMessages(visitorId, effectiveAgentId);

      // Get the conversation to check aiChat status
      let conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId,
        effectiveAgentId
      );
      let aiChat = true; // Default to true (AI chat mode)

      if (chatMessages.length <= 0) {
        const conversationId = conversation?._id || null;

        await ChatMessageController.createChatMessage(
          conversationId,
          visitorId,
          "system",
          themeSettings?.welcomeMessage,
          userId,
          effectiveAgentId
        );

        chatMessages = await ChatMessageController.getAllChatMessages(
          visitorId,
          effectiveAgentId
        );
      }

      // Get aiChat status from conversation
      if (conversation) {
        aiChat = conversation.aiChat !== undefined ? conversation.aiChat : true;
        console.log('🔌 visitor-connect: aiChat status:', aiChat, 'for conversation:', conversation._id);
      } else {
        console.log('⚠️ visitor-connect: No conversation found, defaulting aiChat to true');
      }

      // Prepare conversation feedback data
      const conversationFeedback = conversation ? {
        feedback: conversation.feedback,
        comment: conversation.comment
      } : null;

      conversationRoom = `conversation-${conversation?._id}`;
      socket.join(conversationRoom);

      // Emit visitor-connect-response directly to the visitor.
      // socket.to(room) EXCLUDES the sender — the visitor would never receive it.
      io.to(conversationRoom).emit("visitor-connect-response", {
        conversationId: conversation?._id,
        chatMessages,
        themeSettings,
        aiChat: aiChat,
        conversationFeedback: conversationFeedback,
      });
    } catch (error) {
      console.error("Error handling visitor-connect:", error);
      socket.emit("error", { message: "Failed to connect visitor" });
    }
  });

  socket.on(
    "save-visitor-details",
    async ({ location, ip, visitorDetails }, callback) => {
      try {
        await VisitorController.updateVisitorById({
          id: visitorId,
          location,
          ip,
          visitorDetails,
        });
      } catch (error) {
        console.error("save-visitor-details error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on("visitor-send-message", async ({ message, id, replyTo }, callback) => {
    try {
      const conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId,
        agentId
        // socket.humanAgentId
      );
      const conversationId = conversation?._id || null;
      const messages = await ChatMessage.find({
        conversation_id: conversationId,
      });
      if (messages.length <= 1) {
        const LimitAvailable = await checkPlanLimits(userId, "query");
        if (!LimitAvailable.canMakeQueries) {
          await Client.updateOne({ userId },{ $set: { "upgradePlanStatus.chatLimitExceeded": true }  });
          socket.emit("visitor-connect-response-upgrade");
          return;
        }
        await Conversation.findByIdAndUpdate(conversationId, {
          is_started: true,
        });
        io.to([agentRoom]).emit(
          "visitor-connect-list-update",
          {}
        );
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
        replyTo
      );

      if (replyTo) {
        await chatMessage.populate("replyTo", "sender message createdAt sender_type humanAgentId");
      }

      const chatMessageObj = chatMessage.toObject ? chatMessage.toObject() : chatMessage;

      io.to(conversationRoom).emit(
        "conversation-append-message",
        {
          chatMessage: chatMessageObj,
        }
      );
      await Conversation.updateOne(
        { _id: conversationId },
        { $inc: { newMessage: 1 }, $set: { lastMessage: message } }
      );
      io.to([agentRoom]).emit("new-message-count", { conversationId, lastMessage: message });
      callback?.({ success: true, chatMessage: chatMessageObj, id });
      if (conversation.aiChat) {
        const response_data = await QueryController.handleQuestionAnswer(
          userId,
          agentId,
          message,
          conversationId
        );
        io.to(conversationRoom).emit("intermediate-response", {
          message: "...replying",
          conversationId,
        });

        // Check if visitor requested agent connection and liveAgentSupport is enabled
        if (response_data.isAgentRequest) {
          const agentData = await Agent.findOne({ _id: agentId }).lean();
          if (agentData && agentData.liveAgentSupport === true) {
            // Get visitor and conversation details for notification
            const visitor = await Visitor.findById(visitorId).lean();
            const conversationDoc = await Conversation.findById(conversationId).lean();
            
            // Emit agent connection request to visitor (show connecting state)
            io.to(conversationRoom).emit("agent-connection-request", {
              conversationId,
              visitorId,
              message: "Connecting to agent...",
            });

            // Same start time for countdown + sessionStorage dismiss key on every replay (e.g. check-pending).
            const requestStartedAt = Date.now();

            // Emit notification to client and agents with sound
            const notificationData = {
              conversationId,
              visitorId,
              agentId,
              visitor: visitor,
              message: "Visitor requested to connect to an agent",
              timestamp: new Date(),
              requestStartedAt,
            };

            // Emit to client room and agent room (inbox receives from agentRoom)
            // Note: emit to array deduplicates – sockets in both rooms only receive it once.
            io.to([agentRoom]).emit("agent-connection-notification", notificationData);

            // Create per-agent DB notifications (do NOT re-emit to agentRoom – already done above)
            const agents = await HumanAgent.find({ agentId, status: 'approved', isActive: true }).lean();
            if (agents.length > 0) {
              for (const agent of agents) {
                await NotificationController.createAgentConnectionNotification(
                  agent._id,
                  conversationId,
                  visitorId,
                  userId,
                  "Visitor requested to connect to an agent",
                  agentId
                );
              }
            }

            // Set up 20-second timeout
            const timeoutId = setTimeout(async () => {
              // Check if conversation was already accepted
              const updatedConversation = await Conversation.findById(conversationId).lean();
              if (updatedConversation && updatedConversation.aiChat === true) {
                // No agent accepted, continue in AI mode
                const timeoutMessage = await ChatMessageController.createChatMessage(
                  conversationId,
                  "",
                  "ai",
                  "Sorry, currently there is no active agent available. I'll continue helping you.",
                  userId
                );
                
                io.to(conversationRoom).emit("conversation-append-message", {
                  chatMessage: timeoutMessage,
                });

                // Emit to visitor that connection failed
                io.to(conversationRoom).emit("agent-connection-timeout", {
                  conversationId,
                });

                // Cancel notifications
                // io.to(`user-${userId}`).emit("agent-connection-cancelled", { conversationId });
                // agents.forEach(agent => {
                //   io.to().emit("agent-connection-cancelled", { conversationId });
                // });

                // Remove timeout from map
                agentConnectionTimeouts.delete(conversationId.toString());
              }
            }, 20000); // 20 seconds

            // Store timeout + start time (check-pending replays need requestStartedAt for dismiss/sessionStorage)
            agentConnectionTimeouts.set(conversationId.toString(), {
              timeoutId,
              requestStartedAt,
            });
            
            return; // Don't send AI response if agent connection is requested
          }
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
              response_data?.sources
            );
          await Conversation.updateOne(
            { _id: conversationId },
            { $set: { lastMessage: stripHtml(response_data.answer) } }
          );
          io.to(conversationRoom).emit(
            "conversation-append-message",
            {
              chatMessage: chatMessageResponse,
              sources: response_data?.sources,
            }
          );
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
              agentId
            );
          await Conversation.updateOne(
            { _id: conversationId },
            { $set: { lastMessage: stripHtml(fallbackText) } }
          );
          io.to(conversationRoom).emit(
            "conversation-append-message",
            { chatMessage: chatMessageResponse }
          );
        }
      }
    } catch (error) {
      console.error("visitor-send-message error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on(
    "conversation-feedback",
    async ({ conversationId, feedback, comment }, callback) => {
      try {
        await ConversationController.updateFeedback(
          conversationId,
          feedback,
          comment
        );
        callback?.({ success: true });

        // Build the conversation room from the payload so we don't depend on the
        // closure variable (which is only set after visitor-connect fires).
        const feedbackConvRoom = `conversation-${conversationId}`;
        const rooms = [agentRoom, feedbackConvRoom].filter(Boolean);
        console.log(`[conversation-feedback] emitting conversation-feedback-update to rooms:`, rooms, { conversationId, feedback, comment });
        io.to(rooms).emit("conversation-feedback-update", {
          conversationId,
          feedback,
          comment,
        });
      } catch (error) {
        console.error("message-feedback error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "close-conversation-visitor",
    async ({ conversationId, status }, callback) => {
      try {
        let closedByName = "Visitor";
        try {
          const visitorDoc = await Visitor.findById(socket.visitorId).lean();
          if (visitorDoc?.name) closedByName = visitorDoc.name;
        } catch (_) {
          /* keep default */
        }
        await ConversationController.UpdateConversationStatusOpenClose(
          conversationId,
          status,
          status === "close" ? closedByName : undefined
        );

        const conversation = await Conversation.findById(conversationId).lean();

        if (status === "close" && conversation) {
          const closeLine = await ChatMessageController.createChatMessage(
            conversationId,
            conversation.visitor,
            "agent-connect",
            `Chat ended: ${closedByName} closed the chat.`,
            conversation.userId,
            conversation.agentId || agentId
          );
          const closeLineObj = closeLine.toObject ? closeLine.toObject() : closeLine;
          io.to(`conversation-${conversationId}`).emit("conversation-append-message", {
            chatMessage: closeLineObj,
          });
        }

        callback?.({ success: true });

        if (conversation) {
          // Emit to conversation room
          io.to([ agentRoom, conversationRoom]).emit("visitor-close-chat", {
            conversationStatus: "close",
          });
          
          // Emit to client room
          // if (userId) {
          //   io.to(`user-${userId}`).emit("conversation-close-triggered", {
          //     conversationStatus: "close",
          //     conversationId: conversationId
          //   });
          // }
          
          // Emit to agent room if conversation is assigned to an agent
          // if (humanAgentId) {
          //   io.to(`user-${humanAgentId}`).emit("conversation-close-triggered", {
          //     conversationStatus: "close",
          //     conversationId: conversationId
          //   });
          // }
          
          // Also emit to all agents for this client
          // if (userId) {
          //   const Agent = require("../models/Agent");
          //   const agents = await Agent.find({ userId, status: 'approved' }).lean();
          //   agents.forEach(agent => {
          //     io.to(`user-${agent._id}`).emit("conversation-close-triggered", {
          //       conversationStatus: "close",
          //       conversationId: conversationId
          //     });
          //   });
          // }
        }
        
      } catch (error) {
        console.error("close-conversation error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
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
};