// handlers/clientHandlers.js
const ScrappingController = require("../controllers/ScrapingController");
const ChatMessageController = require("../controllers/ChatMessageController");
const VisitorController = require("../controllers/VisitorController");
const ConversationController = require("../controllers/ConversationController");
const ConversationTagController = require("../controllers/ConversationTagController");
const DashboardController = require("../controllers/DashboardController");
const Conversation = require("../models/Conversation");
const Visitor = require("../models/Visitor");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const PlanService = require("../services/PlanService");
const { agentConnectionTimeouts } = require("./visitorHandlers");

const initializeClientEvents = (io, socket) => {
  const { agentId } = socket;
  const { userId } = socket;
  let conversationRoom = ``;
  let clientRoom = "";
  let agentRoom = "";

  if (agentId) {
    agentRoom = `user-${agentId}`;
  }
  if (!agentId && userId) {
    clientRoom = `user-${userId}`;
  }
  socket.join(agentRoom);
  socket.join(clientRoom);

  socket.on("client-connect", async () => {
    socket.emit("client-connect-response", {
      response: "Client Connect Successful",
    });
  });

  socket.on("get-training-list-count", async () => {
    const data = await Client.findOne({userId});

    socket.emit("get-training-list-count-response", {
      response: "Received data from message",
      data,
    });
  });

  socket.on("get-training-list", async (data) => {
    const { skip, limit, sourcetype, actionType } = data;
    let status = actionType;
    let type = sourcetype
    const webPages = await ScrappingController.getScrapingHistoryBySocket(
      userId,
      skip,
      limit,
      type,
      status,
    );
    socket.emit("get-training-list-response", {
      response: "Received data from message",
      data: webPages,
    });
  });

  socket.on("continue-scrapping-button",async ()=>{
    const clientData = await Client.findOne({userId});
    if(clientData?.pagesAdded?.success+clientData?.pagesAdded?.failed<clientData?.pagesAdded?.total && clientData?.upgradePlanStatus?.storageLimitExceeded != true && clientData?.dataTrainingStatus ==0){
      socket.emit("show-continue-scrapping-button", {
        response: "show button",
      });
    }
  })

  socket.on("get-open-conversations-list", async (data) => {
    try {
      const conv = await Conversation.find({
        userId: userId,
        // agentId: socket.agentId,
        conversationOpenStatus: "open",
      }).populate('agentId', 'name avatar isClient').sort({ createdAt: -1 });

      const updatedVisitors = await Promise.all(
        conv.map(async (conv) => {
          const conversation = conv.toObject();
          const visitor = await Visitor.findOne({ _id: conv.visitor });
          conversation["visitor"] = visitor;
          return conversation;
        })
      );

      socket.emit("get-open-conversations-list-response", {
        status: "success",
        conversations: updatedVisitors,
      });
    } catch (error) {
      console.error("Error fetching conversations list:", error);
      socket.emit("get-open-conversations-list-response", {
        status: "error",
        message: "Failed to fetch conversations list",
      });
    }
  });

  socket.on("get-close-conversations-list", async (data) => {
    try {
      const conv = await Conversation.find({
        userId: userId,
        // agentId: socket.agentId,
        conversationOpenStatus: "close",
      }).populate('agentId', 'name avatar isClient').sort({ createdAt: -1 });

      const updatedVisitors = await Promise.all(
        conv.map(async (conv) => {
          const conversation = conv.toObject();
          const visitor = await Visitor.findOne({ _id: conv.visitor });
          conversation["visitor"] = visitor;
          return conversation;
        })
      );

      socket.emit("get-close-conversations-list-response", {
        status: "success",
        conversations: updatedVisitors,
      });
    } catch (error) {
      console.error("Error fetching close conversations list:", error);
      socket.emit("get-close-conversations-list-response", {
        status: "error",
        message: "Failed to fetch close conversations list",
      });
    }
  });

  socket.on("set-conversation-id", async ({ conversationId }, callback) => {
    try {
       // Leave previous conversation room if exists
      if (conversationRoom) {
        socket.leave(conversationRoom);
      }
      conversationRoom = `conversation-${conversationId}`;
      await socket.join(conversationRoom);
        // Send success callback
      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (error) {
      console.error("set-conversation-id error:", error.message);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
    }
  });

  // Check for pending agent connection request when joining a conversation
  socket.on("check-pending-agent-request", async ({ conversationId }, callback) => {
    try {
      // Check if there's an active timeout for this conversation
      const hasPendingRequest = agentConnectionTimeouts.has(conversationId?.toString());
      
      if (hasPendingRequest) {
        // Get conversation and visitor details
        const conversation = await Conversation.findById(conversationId).lean();
        if (conversation && conversation.aiChat === true) {
          const visitor = await Visitor.findById(conversation.visitor).lean();
          
          const notificationData = {
            conversationId,
            visitorId: conversation.visitor,
            visitor: visitor,
            message: "Visitor requested to connect to an agent",
            timestamp: new Date(),
          };
          
          // Emit the notification to this socket
          socket.emit("agent-connection-notification", notificationData);
          
          callback?.({ success: true, hasPendingRequest: true });
        } else {
          callback?.({ success: true, hasPendingRequest: false });
        }
      } else {
        callback?.({ success: true, hasPendingRequest: false });
      }
    } catch (error) {
      console.error("check-pending-agent-request error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("message-seen", async ({ conversationId }, callback) => {
    try {
      await Conversation.updateOne(
        { _id: conversationId },
        { $set: { newMessage: 0 } }
      );
    } catch (error) {
      console.error("update message-seen error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  // Handle agent typing events - only emit when aiChat = false
  socket.on("agent-start-typing", async ({ conversationId, visitorId }, callback) => {
    try {
      console.log('⌨️ agent-start-typing received:', { conversationId, visitorId, userId });
      
      // Get conversation to check aiChat status
      const conversation = await Conversation.findOne({ _id: conversationId });
      
      if (!conversation) {
        console.log('⚠️ Conversation not found for typing event');
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      // Only emit typing event if aiChat is false (agent chat mode)
      if (!conversation.aiChat) {
        console.log('✅ Emitting agent-typing event (aiChat = false)');
        io.to([
          `conversation-${conversationId}`,
          `conversation-${visitorId}`,
        ]).emit("agent-typing", {
          conversationId,
          visitorId
        });
        callback?.({ success: true });
      } else {
        console.log('⏭️ Ignoring agent-typing event (aiChat = true, AI mode)');
        callback?.({ success: true, ignored: true, reason: "AI chat mode" });
      }
    } catch (error) {
      console.error("agent-start-typing error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("agent-stop-typing", async ({ conversationId, visitorId }, callback) => {
    try {
      console.log('⏹️ agent-stop-typing received:', { conversationId, visitorId, userId });
      
      // Get conversation to check aiChat status
      const conversation = await Conversation.findOne({ _id: conversationId });
      
      if (!conversation) {
        console.log('⚠️ Conversation not found for stop typing event');
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      // Only emit stop typing event if aiChat is false (agent chat mode)
      if (!conversation.aiChat) {
        console.log('✅ Emitting agent-stop-typing event (aiChat = false)');
        io.to([
          `conversation-${conversationId}`,
          `conversation-${visitorId}`,
        ]).emit("agent-stop-typing", {
          conversationId,
          visitorId
        });
        callback?.({ success: true });
      } else {
        console.log('⏭️ Ignoring agent-stop-typing event (aiChat = true, AI mode)');
        callback?.({ success: true, ignored: true, reason: "AI chat mode" });
      }
    } catch (error) {
      console.error("agent-stop-typing error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("client-send-message", async ({ message, visitorId }, callback) => {
    try {
      const conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId
        // socket.agentId
      );
      const conversationId = conversation?._id || null;

      // Get agentId if socket type is agent, or find client's agent record
      let agentIdForMessage;
      if (socket.type === "agent") {
        agentIdForMessage = socket.agentId;
      } else if (socket.type === "client") {
        // Find the client's agent record (isClient: true)
        const clientAgent = await Agent.findOne({ userId: userId, isClient: true });
        agentIdForMessage = clientAgent ? clientAgent._id : undefined;
      }

      const chatMessage = await ChatMessageController.createChatMessage(
        conversationId,
        visitorId,
        "agent",
        message,
        userId,
        undefined,
        agentIdForMessage
      );

      // Populate agent info before emitting
      if (agentIdForMessage) {
        await chatMessage.populate('agentId', 'name avatar isClient');
      }

      // Convert to plain object to ensure populated fields are included
      const chatMessageObj = chatMessage.toObject ? chatMessage.toObject() : chatMessage;

      // Emit stop-typing event when message is sent (if in agent mode)
      // Fetch conversation again to get latest aiChat status
      const conversationDoc = await Conversation.findOne({ _id: conversationId });
      if (conversationDoc && !conversationDoc.aiChat) {
        console.log('📤 Agent sent message, emitting agent-stop-typing');
        io.to([
          `conversation-${conversationId}`,
          `conversation-${visitorId}`,
        ]).emit("agent-stop-typing", {
          conversationId,
          visitorId
        });
      }

      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit("conversation-append-message", { chatMessage: chatMessageObj });

      callback?.({ success: true, chatMessage: chatMessageObj });
    } catch (error) {
      console.error("client-send-message error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("client-send-add-note",async ({ message, visitorId, conversationId }, callback) => {
      try {
        // Get agentId if socket type is agent, or find client's agent record
        let agentIdForMessage;
        if (socket.type === "agent") {
          agentIdForMessage = socket.agentId;
        } else if (socket.type === "client") {
          // Find the client's agent record (isClient: true)
          const clientAgent = await Agent.findOne({ userId: userId, isClient: true });
          agentIdForMessage = clientAgent ? clientAgent._id : undefined;
        }

        const note = await ChatMessageController.addNoteToChat(
          visitorId,
          "agent",
          message,
          conversationId,
          userId,
          agentIdForMessage
        );

        // Populate agent info before emitting
        if (agentIdForMessage) {
          await note.populate('agentId', 'name avatar isClient');
        }

        // Convert to plain object to ensure populated fields are included
        const noteObj = note.toObject ? note.toObject() : note;

        await io.to(`conversation-${conversationId}`).emit("note-append-message", {
          note: noteObj,
        });

        callback?.({ success: true, note: noteObj });
      } catch (error) {
        console.error("client-send-add-note error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on("get-all-note-messages", async ({ conversationId }, callback) => {
    try {
      const notes = await ChatMessageController.getAllChatNotesMessages(
        conversationId
      );
      callback?.({ success: true, notes: notes });
    } catch (error) {
      console.error("get-all-note-messages error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on(
    "get-visitor-old-conversations",
    async ({ visitorId }, callback) => {
      try {
        const conversations =
          await ConversationController.getAllOldConversations(visitorId);
        callback?.({ success: true, conversations: conversations });
      } catch (error) {
        console.error("get-visitor-old-conversations error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "add-conversation-tag",
    async ({ name, conversationId }, callback) => {
      try {
        const updatedTags = await ConversationTagController.createTag({
          name,
          conversationId,
          userId,
        });
        callback({ success: true, tags: updatedTags });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    }
  );

  socket.on("get-conversation-tags", async ({ conversationId }, callback) => {
    try {
      const tags = await ConversationTagController.getAllTagsOfConversation({
        conversationId,
      });
      io.to(`conversation-${conversationId}`).emit("get-tags-response", { tags });
       // Also send response via callback if provided
      if (typeof callback === 'function') {
        callback({ success: true, tags });
      }
    } catch (error) {
       console.error("get-conversation-tags error:", error.message);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
    }
  });


  socket.on(
    "remove-conversation-tag",
    async ({ id, conversationId }, callback) => {
      try {
        const updatedTags = await ConversationTagController.deleteTagById({
          id,
        });
        callback({ success: true, tags: updatedTags });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "close-conversation",
    async ({ conversationId, status }, callback) => {
      try {
        let conversation = await Conversation.findOne({
          _id: conversationId,
          conversationOpenStatus: "open",
        });

         if (!conversation) {
        if (typeof callback === 'function') {
          callback({ success: false, error: "Conversation not found or already closed" });
        }
        return;
      }
      
      let visitorId = conversation?.visitor;

        await ConversationController.UpdateConversationStatusOpenClose(
          conversationId,
          status
        );

           // Notify all relevant rooms about the conversation closure
      io.to(`conversation-${conversationId}`).emit("conversation-close-triggered", { 
        conversationStatus: "close" 
      });
      
      io.to(clientRoom).emit("conversation-close-triggered", { 
        conversationStatus: "close" 
      });
      
      io.to(agentRoom).emit("conversation-close-triggered", { 
        conversationStatus: "close" 
      });
      
      io.to(`conversation-${visitorId}`).emit("visitor-conversation-close", {
        conversationStatus: "close",
      });

      if (typeof callback === 'function') {
        callback({ success: true });
      }

        // callback({ success: true });
        // io.to(clientRoom).emit("conversation-close-triggered", {});
        // io.to(agentRoom).emit("conversation-close-triggered", {});
        // io.to(`conversation-${visitorId}`).emit("visitor-conversation-close", {
        //   conversationStatus: "close",
        // });
      } catch (error) {
        // callback({ success: false, error: error.message });
         console.error("close-conversation error:", error.message);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
      }
    }
  );

  socket.on(
    "block-visitor",
    async ({ visitorId, conversationId }, callback) => {
      try {
        await VisitorController.blockVisitor({ visitorId });

        await ConversationController.UpdateConversationStatusOpenClose(
          conversationId,
          "close"
        );

           // Notify all relevant rooms about the visitor block
      io.to(`conversation-${conversationId}`).emit("visitor-blocked", {
        conversationStatus: "close",
      });
      
      io.to(clientRoom).emit("conversation-close-triggered", {
        conversationStatus: "close"
      });
      
      io.to(agentRoom).emit("conversation-close-triggered", {
        conversationStatus: "close"
      });
      
      io.to(`conversation-${visitorId}`).emit("visitor-blocked", {
        conversationStatus: "close",
      });

      if (typeof callback === 'function') {
        callback({ success: true });
      }

        // callback({ success: true });
        // io.to(clientRoom).emit("conversation-close-triggered", {});
        // io.to(agentRoom).emit("conversation-close-triggered", {});
        // io.to(`conversation-${visitorId}`).emit("visitor-blocked", {
        //   conversationStatus: "close",
        // });
      } catch (error) {
        // callback({ success: false, error: error.message });
          console.error("block-visitor error:", error.message);
      if (typeof callback === 'function') {
        callback({ success: false, error: error.message });
      }
      }
    }
  );

  socket.on("agent-deleted",async ({}, callback) => {
    try {
      // await AgentController.deleteAgent(agentId);
      io.to(agentRoom).emit("agent-deleted-success");
      // callback({ success: true });
    } catch (error) {
      // callback({ success: false, error: error.message });
      console.error("agent-deleted error:", error.message);
    }
  });

  socket.on("close-ai-response", async ({ conversationId }, callback) => {
    try {
      // Get conversation first to check current aiChat status
      const conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      // Only proceed if aiChat is currently true (to avoid duplicate messages)
      if (!conversation.aiChat) {
        callback?.({ success: true, message: "AI chat already disabled" });
        return;
      }

      const visitorId = conversation?.visitor;
      
      // Get agent/client information who is toggling
      let transferName = "Agent";
      let agentIdForMessage = undefined;
      
      if (socket.type === "agent") {
        // If it's an agent, get the agent details
        agentIdForMessage = socket.agentId;
        const agent = await Agent.findById(agentIdForMessage);
        if (agent) {
          transferName = agent.isClient ? "Client" : agent.name;
        }
      } else if (socket.type === "client") {
        // If it's a client, find the client's agent record
        const clientAgent = await Agent.findOne({ userId: userId, isClient: true });
        if (clientAgent) {
          transferName = "Client";
          agentIdForMessage = clientAgent._id;
        }
      }

      // Disable AI chat and update agentId and transferredAt
      await Conversation.updateOne(
        { _id: conversationId },
        { 
          $set: { 
            aiChat: false,
            agentId: agentIdForMessage || null,
            transferredAt: new Date()
          } 
        }
      );
      
      // Create a system message for the transfer
      const transferMessage = `The chat is transferred to ${transferName}`;
      const systemMessage = await ChatMessageController.createChatMessage(
        conversationId,
        visitorId || "system",
        "system",
        transferMessage,
        userId,
        undefined,
        agentIdForMessage
      );

      // Populate agent info if available
      if (agentIdForMessage) {
        await systemMessage.populate('agentId', 'name avatar isClient');
      }

      // Convert to plain object
      const systemMessageObj = systemMessage.toObject ? systemMessage.toObject() : systemMessage;

      // Broadcast the transfer message to all participants
      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit("conversation-append-message", { chatMessage: systemMessageObj });

      // Broadcast transfer event
      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit("chat-transferred", {
        conversationId,
        transferredTo: transferName,
        agentId: agentIdForMessage
      });
      
      // Emit to both client and visitor rooms
      io.to(`conversation-${conversationId}`).emit('ai-response-update');
      
      // Emit aiChat status update to visitor
      if (visitorId) {
        console.log('🔄 Emitting ai-chat-status-update to visitor:', { conversationId, visitorId, aiChat: false });
        io.to([
          `conversation-${conversationId}`,
          `conversation-${visitorId}`,
        ]).emit('ai-chat-status-update', {
          aiChat: false,
          conversationId
        });
      }
      
      callback?.({ success: true });
    } catch (error) {
      console.error("close-ai-response error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("search-conversations", async ({ query }, callback) => {
    try {
      const visitors = await ConversationController.searchByTagOrName(
        query,
        userId
      );
      callback({ success: true, data: visitors });
    } catch (error) {
      console.error("Error during search:", error);
      callback({ success: false, error: error.message });
    }
  });

  ///////dashboard////////////
  socket.on("fetch-dashboard-data", async ({ dateRange }, callback) => {
    try {
      // Fetch data from the database based on date range
      const data = await DashboardController.getDashboardData(
        dateRange,
        socket.userId
      );
      const analytics = await DashboardController.getUsageAnalytics(socket.userId);
      const plan = await PlanService.getUserPlan(socket.userId);
      callback({ success: true, data, analytics, plan });
    } catch (error) {
      console.error("Error fetching dashboard data:", error);
      callback({ success: false, error: "Failed to fetch data" });
    }
  });

  // Emit real-time updates to all clients
  // setInterval(async () => {
  //   const realTimeData = await getRealTimeUpdates(); // Replace with actual DB logic
  //   io.emit('update-dashboard-data', realTimeData);
  // }, 5000);
  ////////////////dash end///////////

  // Handle agent connection accept
  socket.on("accept-agent-connection", async ({ conversationId }, callback) => {
    try {
      const conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      // Check if already accepted
      if (!conversation.aiChat) {
        callback?.({ success: true, message: "Already connected to agent" });
        return;
      }

      const visitorId = conversation?.visitor;
      
      // Get agent/client information who is accepting
      let transferName = "Agent";
      let agentIdForMessage = undefined;
      
      if (socket.type === "agent") {
        agentIdForMessage = socket.agentId;
        const agent = await Agent.findById(agentIdForMessage);
        if (agent) {
          transferName = agent.isClient ? "Client" : agent.name;
        }
      } else if (socket.type === "client") {
        const clientAgent = await Agent.findOne({ userId: userId, isClient: true });
        if (clientAgent) {
          transferName = "Client";
          agentIdForMessage = clientAgent._id;
        }
      }

      // Disable AI chat and assign to agent
      await Conversation.updateOne(
        { _id: conversationId },
        { 
          $set: { 
            aiChat: false,
            agentId: agentIdForMessage || null,
            transferredAt: new Date()
          } 
        }
      );
      
      // Create a system message for the transfer
      const transferMessage = `Connected to ${transferName}`;
      const systemMessage = await ChatMessageController.createChatMessage(
        conversationId,
        visitorId || "system",
        "system",
        transferMessage,
        userId,
        undefined,
        agentIdForMessage
      );

      // Populate agent info if available
      if (agentIdForMessage) {
        await systemMessage.populate('agentId', 'name avatar isClient');
      }

      const systemMessageObj = systemMessage.toObject ? systemMessage.toObject() : systemMessage;

      // Broadcast the transfer message
      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit("conversation-append-message", { chatMessage: systemMessageObj });

      // Emit aiChat status update
      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit('ai-chat-status-update', {
        aiChat: false,
        conversationId
      });

      // Notify visitor that agent accepted
      io.to(`conversation-${visitorId}`).emit("agent-connection-accepted", {
        conversationId,
        agentName: transferName,
      });

      // Cancel any pending notifications for other agents/clients
      io.to(`user-${userId}`).emit("agent-connection-cancelled", { conversationId });
      const agents = await Agent.find({ userId, status: 'approved' }).lean();
      agents.forEach(agent => {
        io.to(`user-${agent._id}`).emit("agent-connection-cancelled", { conversationId });
      });

      // Clear timeout if exists
      io.to(`conversation-${conversationId}`).emit("agent-connection-accepted-clear-timeout", { conversationId });

      callback?.({ success: true });
    } catch (error) {
      console.error("accept-agent-connection error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  // Handle agent connection decline
  socket.on("decline-agent-connection", async ({ conversationId }, callback) => {
    try {
      // Just cancel the notification, don't change conversation state
      io.to(`user-${userId}`).emit("agent-connection-cancelled", { conversationId });
      
      if (socket.type === "agent") {
        io.to(`user-${socket.agentId}`).emit("agent-connection-cancelled", { conversationId });
      } else {
        const agents = await Agent.find({ userId, status: 'approved' }).lean();
        agents.forEach(agent => {
          io.to(`user-${agent._id}`).emit("agent-connection-cancelled", { conversationId });
        });
      }

      callback?.({ success: true });
    } catch (error) {
      console.error("decline-agent-connection error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
      if (clientRoom) socket.leave(clientRoom);
    if (agentRoom) socket.leave(agentRoom);
    if (conversationRoom) socket.leave(conversationRoom);
    console.log("User disconnected from client socket");
  });
};

module.exports = {
  initializeClientEvents,
};
