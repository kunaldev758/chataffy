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
const PlanService = require("../services/PlanService");

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
      }).sort({ createdAt: -1 });

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
      }).sort({ createdAt: -1 });

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

  socket.on("client-send-message", async ({ message, visitorId }, callback) => {
    try {
      const conversation = await ConversationController.getOpenConversation(
        visitorId,
        userId
        // socket.agentId
      );
      const conversationId = conversation?._id || null;

      const chatMessage = await ChatMessageController.createChatMessage(
        conversationId,
        visitorId,
        "agent",
        message,
        userId
      );

      io.to([
        `conversation-${conversationId}`,
        `conversation-${visitorId}`,
      ]).emit("conversation-append-message", { chatMessage });

      callback?.({ success: true, chatMessage });
    } catch (error) {
      console.error("client-send-message error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("client-send-add-note",async ({ message, visitorId, conversationId }, callback) => {
      try {
        const note = await ChatMessageController.addNoteToChat(
          visitorId,
          "agent",
          message,
          conversationId,
          userId
        );

        await io.to(`conversation-${conversationId}`).emit("note-append-message", {
          note,
        });

        callback?.({ success: true, note });
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

  socket.on("close-ai-response", async ({ conversationId }, callback) => {
    try {
      await ConversationController.disableAiChat({ conversationId });
      io.to(`conversation-${conversationId}`).emit('ai-response-update');
      // callback({ success: true });
    } catch (error) {
      // callback({ success: false, error: error.message });
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
