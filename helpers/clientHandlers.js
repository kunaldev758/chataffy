// handlers/clientHandlers.js
const CreditsController = require("../controllers/CreditsController");
const OpenaiTrainingListController = require("../controllers/OpenaiTrainingListController");
const ChatMessageController = require("../controllers/ChatMessageController");
const VisitorController = require("../controllers/VisitorController");
const ConversationController = require("../controllers/ConversationController");
const ConversationTagController = require("../controllers/ConversationTagController");
const DashboardController = require("../controllers/DashboardController");
const Conversation = require("../models/Conversation");

const initializeClientEvents = (io, socket) => {
  const { userId } = socket;
  let conversationRoom = ``;
  const clientRoom = `user-${userId}`;
  socket.join(clientRoom);

  socket.on("client-connect", async () => {
    socket.emit("client-connect-response", {
      response: "Received data from message",
    });
  });

  socket.on("get-credit-count", async (data) => {
    const credits = await CreditsController.getUserCredits(userId);
    socket.emit("get-credit-count-response", {
      response: "Received data from message",
      data: credits,
    });
  });
  socket.on("get-training-list-count", async (data) => {
    const webPagesCount =
      await OpenaiTrainingListController.getWebPageUrlCount(userId);
    const docSnippets = await OpenaiTrainingListController.getSnippetCount(
      userId
    );
    // {crawledDocs: 0, totalDocs: 0};
    const faqs = await OpenaiTrainingListController.getFaqCount(userId);
    // {crawledFaqs: 0,totalFaqs: 0};
    socket.emit("get-training-list-count-response", {
      response: "Received data from message",
      data: { ...webPagesCount, ...docSnippets, ...faqs },
    });
  });
  socket.on("get-training-list", async (data) => {
    const { skip, limit, sourcetype, actionType } = data;
    const webPages = await OpenaiTrainingListController.getWebPageList(
      userId,
      skip,
      limit,
      sourcetype,
      actionType
    );
    socket.emit("get-training-list-response", {
      response: "Received data from message",
      data: webPages,
    });
  });

  socket.on("get-open-conversations-list", async (data) => {
    try {
      const conv = await Conversation.find({
        userId: userId,
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

      // Emit the response back to the frontend
      socket.emit("get-open-conversations-list-response", {
        status: "success",
        conversations: updatedVisitors,
      });
    } catch (error) {
      console.error("Error fetching conversations list:", error);

      // Emit an error response
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

      // Emit the response back to the frontend
      socket.emit("get-close-conversations-list-response", {
        status: "success",
        conversations: updatedVisitors,
      });
    } catch (error) {
      console.error("Error fetching close conversations list:", error);
      // Emit an error response
      socket.emit("get-close-conversations-list-response", {
        status: "error",
        message: "Failed to fetch close conversations list",
      });
    }
  });

  socket.on("set-conversation-id", async ({ conversationId }, callback) => {
    try {
      socket.leave(conversationRoom);
      conversationRoom = `conversation-${conversationId}`;
      socket.join(conversationRoom);
    } catch (error) {
      console.error("set-conversation-id error:", error.message);
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

  socket.on(
    "client-send-message",
    async ({ message, visitorId }, callback) => {
      try {
        const conversation =
          await ConversationController.getOpenConversation(
            visitorId,
            userId
          );
        const conversationId = conversation?._id || null;

        const chatMessage = await ChatMessageController.createChatMessage(
          conversationId,
          visitorId,
          "agent",
          message,
          userId
        );

        io.to(`conversation-${visitorId}`).emit(
          "conversation-append-message",
          { chatMessage }
        );
        callback?.({ success: true, chatMessage });
      } catch (error) {
        console.error("client-send-message error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "client-send-add-note",
    async ({ message, visitorId, conversationId }, callback) => {
      try {
        const note = await ChatMessageController.addNoteToChat(
          visitorId,
          "agent",
          message,
          conversationId,
          userId
        );
        callback?.({ success: true, note });
      } catch (error) {
        console.error("client-send-add-note error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "get-all-note-messages",
    async ({ conversationId }, callback) => {
      try {
        const notes = await ChatMessageController.getAllChatNotesMessages(
          conversationId
        );
        callback?.({ success: true, notes: notes });
      } catch (error) {
        console.error("get-all-note-messages error:", error.message);
        callback?.({ success: false, error: error.message });
      }
    }
  );

  socket.on(
    "get-visitor-old-conversations",
    async ({ visitorId }, callback) => {
      try {
        const conversations =
          await ConversationController.getAllOldConversations(visitorId);
        callback?.({ success: true, conversations: conversations });
      } catch (error) {
        console.error(
          "get-visitor-old-conversations error:",
          error.message
        );
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

  socket.on(
    "get-conversation-tags",
    async ({ conversationId }, callback) => {
      try {
        const tags =
          await ConversationTagController.getAllTagsOfConversation({
            conversationId,
          });
        callback({ success: true, tags });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    }
  );

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
        let visitorId = conversation?.visitor;

        await ConversationController.UpdateConversationStatusOpenClose(
          conversationId,
          status
        );

        callback({ success: true });
        io.to(`conversation-${visitorId}`).emit(
          "visitor-conversation-close",
          { conversationStatus: "close" }
        );
      } catch (error) {
        callback({ success: false, error: error.message });
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

        callback({ success: true });
        io.to(`conversation-${visitorId}`).emit("visitor-blocked", {
          conversationStatus: "close",
        });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    }
  );

  socket.on("close-ai-response", async ({ conversationId }, callback) => {
    try {
      await ConversationController.disableAiChat({ conversationId });
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
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
      callback({ success: true, data });
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
    socket.leave(clientRoom);
    socket.leave(conversationRoom);
  });
};

module.exports = {
  initializeClientEvents
};