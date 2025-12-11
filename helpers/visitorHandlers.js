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
const BlockedVisitorIp = require("../models/blockedVisitorIp");
const { checkPlanLimits } = require("../services/PlanService");

// Store active timeouts for agent connection requests
const agentConnectionTimeouts = new Map();

// Export for use in other handlers
module.exports.agentConnectionTimeouts = agentConnectionTimeouts;

const initializeVisitorEvents = (io, socket) => {
  const { agentId } = socket;
  const { userId } = socket;
  const { visitorId } = socket;
  let conversationRoom = ``;
  let clientRoom = "";
  let agentRoom = "";

  if (agentId) {
    agentRoom = `user-${agentId}`;
  }
  if (!agentId && userId) {
    clientRoom = `user-${userId}`;
  }

  const VisitorRoom = `conversation-${visitorId}`;
  socket.join(VisitorRoom);

  socket.on("visitor-ip", async ({ ip }, callback) => {
    try {
      const ipFound = await BlockedVisitorIp.findOne({
        ip: ip,
        userId: userId,
      });
      if (ipFound) {
        io.to(`conversation-${visitorId}`).emit("visitor-is-blocked", {});
      }
    } catch (error) {
      console.error("visitor-ip error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("visitor-connect", async ({ widgetToken }) => {
    try {
      // Fetch theme settings for the widget
      // const LimitAvailable = await checkPlanLimits(userId, "query");
      // if (!LimitAvailable.canMakeQueries) {
      //   await Client.updateOne({ userId },{ $set: { "upgradePlanStatus.chatLimitExceeded": true }  });
      //   socket.emit("visitor-connect-response-upgrade");
      //   return;
      // }
      const themeSettings = await Widget.findOne({ widgetToken });

      // Fetch the visitor's conversation history
      let chatMessages = [];
      chatMessages = await ChatMessageController.getAllChatMessages(visitorId);

      // Get the conversation to check aiChat status
      let conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId
      );
      let aiChat = true; // Default to true (AI chat mode)

      if (chatMessages.length <= 0) {
        const conversationId = conversation?._id || null;

        await ChatMessageController.createChatMessage(
          conversationId,
          visitorId,
          "bot",
          themeSettings?.welcomeMessage,
          userId
        );

        chatMessages = await ChatMessageController.getAllChatMessages(
          visitorId
        );
      }

      // Get aiChat status from conversation
      if (conversation) {
        aiChat = conversation.aiChat !== undefined ? conversation.aiChat : true;
        console.log('🔌 visitor-connect: aiChat status:', aiChat, 'for conversation:', conversation._id);
      } else {
        console.log('⚠️ visitor-connect: No conversation found, defaulting aiChat to true');
      }

      // Emit visitor-connect-response with visitor data
      socket.emit("visitor-connect-response", {
        chatMessages,
        themeSettings,
        aiChat: aiChat,
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

  socket.on("visitor-send-message", async ({ message, id }, callback) => {
    try {
      const conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId
        // socket.agentId
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
        io.to([`user-${userId}`, agentRoom]).emit(
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
        userId
      );

      io.to([`conversation-${conversationId}`, VisitorRoom]).emit(
        "conversation-append-message",
        {
          chatMessage,
        }
      );
      io.to([`user-${userId}`, agentRoom]).emit("new-message-count", {});

      await Conversation.updateOne(
        { _id: conversationId },
        { $inc: { newMessage: 1 } }
      );
      callback?.({ success: true, chatMessage, id });
      if (conversation.aiChat) {
        const response_data = await QueryController.handleQuestionAnswer(
          userId,
          message,
          conversationId
        );
        io.to(`conversation-${visitorId}`).emit("intermediate-response", {
          message: "...replying",
        });
        io.to(`conversation-${conversationId}`).emit("intermediate-response", {
          message: "...replying",
        });

        // Check if visitor requested agent connection and liveAgentSupport is enabled
        if (response_data.isAgentRequest) {
          const clientData = await Client.findOne({ userId }).lean();
          if (clientData && clientData.liveAgentSupport === true) {
            // Get visitor and conversation details for notification
            const visitor = await Visitor.findById(visitorId).lean();
            const conversationDoc = await Conversation.findById(conversationId).lean();
            
            // Emit agent connection request to visitor (show connecting state)
            io.to(`conversation-${visitorId}`).emit("agent-connection-request", {
              conversationId,
              visitorId,
              message: "Connecting to agent...",
            });

            // Emit notification to client and agents with sound
            const notificationData = {
              conversationId,
              visitorId,
              visitor: visitor,
              message: "Visitor requested to connect to an agent",
              timestamp: new Date(),
            };

            // Emit to client room
            io.to(`user-${userId}`).emit("agent-connection-notification", notificationData);
            
            // Emit to all agents for this client
            const agents = await Agent.find({ userId, status: 'approved', isActive: true }).lean();
            agents.forEach(agent => {
              io.to(`user-${agent._id}`).emit("agent-connection-notification", notificationData);
            });

            // Set up 20-second timeout
            const timeoutId = setTimeout(async () => {
              // Check if conversation was already accepted
              const updatedConversation = await Conversation.findById(conversationId).lean();
              if (updatedConversation && updatedConversation.aiChat === true) {
                // No agent accepted, continue in AI mode
                const timeoutMessage = await ChatMessageController.createChatMessage(
                  conversationId,
                  "",
                  "assistant",
                  "Sorry, currently there is no active agent available. I'll continue helping you.",
                  userId
                );
                
                io.to(`conversation-${visitorId}`).emit("conversation-append-message", {
                  chatMessage: timeoutMessage,
                });
                io.to(`conversation-${conversationId}`).emit("conversation-append-message", {
                  chatMessage: timeoutMessage,
                });

                // Emit to visitor that connection failed
                io.to(`conversation-${visitorId}`).emit("agent-connection-timeout", {
                  conversationId,
                });

                // Cancel notifications
                io.to(`user-${userId}`).emit("agent-connection-cancelled", { conversationId });
                agents.forEach(agent => {
                  io.to(`user-${agent._id}`).emit("agent-connection-cancelled", { conversationId });
                });

                // Remove timeout from map
                agentConnectionTimeouts.delete(conversationId.toString());
              }
            }, 20000); // 20 seconds

            // Store timeout ID
            agentConnectionTimeouts.set(conversationId.toString(), timeoutId);
            
            return; // Don't send AI response if agent connection is requested
          }
        }

        if (response_data.success == true) {
          const chatMessageResponse =
            await ChatMessageController.createChatMessage(
              conversationId,
              "",
              "assistant",
              response_data.answer,
              userId,
              response_data?.sources
            );
          io.to(`conversation-${visitorId}`).emit(
            "conversation-append-message",
            {
              chatMessage: chatMessageResponse,
              sources: response_data?.sources,
            }
          );
          io.to(`conversation-${conversationId}`).emit(
            "conversation-append-message",
            {
              chatMessage: chatMessageResponse,
              sources: response_data?.sources,
            }
          );
        } else {
          const chatMessageResponse =
            await ChatMessageController.createChatMessage(
              conversationId,
              "",
              "assistant",
              "error in generating Response",
              userId
            );
          io.to(`conversation-${visitorId}`).emit(
            "conversation-append-message",
            { chatMessage: chatMessageResponse }
          );
          io.to(`conversation-${conversationId}`).emit(
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
    async ({ conversationId, feedback }, callback) => {
      try {
        const updatedMessage = await ConversationController.updateFeedback(
          conversationId,
          feedback
        );
        callback?.({ success: true, updatedMessage });
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
        await ConversationController.UpdateConversationStatusOpenClose(
          conversationId,
          status
        );
        callback?.({ success: true });

        io.to(`conversation-${conversationId}`).emit("visitor-close-chat", {
          conversationStatus: "close",
        });
        socket.leave(conversationRoom);
      } catch (error) {
        console.error("close-conversation error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  // Listen for agent connection accepted to clear timeout
  socket.on("agent-connection-accepted-clear-timeout", ({ conversationId }) => {
    const timeoutId = agentConnectionTimeouts.get(conversationId?.toString());
    if (timeoutId) {
      clearTimeout(timeoutId);
      agentConnectionTimeouts.delete(conversationId?.toString());
      console.log(`Cleared timeout for conversation ${conversationId}`);
    }
  });

  socket.on("disconnect", () => {
    socket.leave(VisitorRoom);
  });
};

module.exports = {
  initializeVisitorEvents,
  agentConnectionTimeouts,
};