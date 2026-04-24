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
const HumanAgent = require("../models/HumanAgent");
const PlanService = require("../services/PlanService");
const { agentConnectionTimeouts } = require("./visitorHandlers");
const { transcriptEmailQueue } = require("../services/jobService");

const stripHtml = (html) => (html || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

/** Pending agent connection: map stores { timeoutId, requestStartedAt } (legacy: raw timeout id number). */
function getAgentConnectionEntry(conversationId) {
  const raw = agentConnectionTimeouts.get(conversationId?.toString());
  if (raw == null) return null;
  if (typeof raw === "number") return { timeoutId: raw, requestStartedAt: null };
  return raw.timeoutId ? raw : null;
}

/**
 * Resolves the human agent id and display name from a socket.
 * Avoids repeated HumanAgent.findOne calls across multiple handlers.
 */
async function resolveHumanAgent(socket, userId) {
  if (socket.type === "human-agent") {
    const humanAgent = await HumanAgent.findById(socket.humanAgentId).lean();
    return {
      id: socket.humanAgentId,
      name: humanAgent ? humanAgent.name : "Agent",
    };
  }
  if (socket.type === "client") {
    const rec = await HumanAgent.findOne({ userId, isClient: true }).lean();
    return rec ? { id: rec._id, name: rec.name } : { id: undefined, name: "Client" };
  }
  return { id: undefined, name: "Agent" };
}

/** System line in the thread when a conversation is closed (dashboard / agent). */
async function appendConversationClosedSystemMessage(io, { conversationId, visitorId, userId, agentId, closedByName }) {
  const message = `Chat ended: ${closedByName} closed the chat.`;
  const chatMessage = await ChatMessageController.createChatMessage(
    conversationId,
    visitorId || "system",
    "agent-connect",
    message,
    userId,
    agentId
  );
  const chatMessageObj = chatMessage.toObject ? chatMessage.toObject() : chatMessage;
  io.to(`conversation-${conversationId}`).emit("conversation-append-message", { chatMessage: chatMessageObj });
}

/**
 * Shared logic for transferring a conversation from AI to a human agent.
 * Used by both close-ai-response and accept-agent-connection.
 */
async function transferChatToHuman(io, { conversationId, visitorId, humanAgentIdForMessage, transferName, userId, agentId, systemMessageText }) {
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        aiChat: false,
        humanAgentId: humanAgentIdForMessage || null,
        transferredAt: new Date(),
      },
    }
  );

  const systemMessage = await ChatMessageController.createChatMessage(
    conversationId,
    visitorId || "system",
    "agent-connect",
    systemMessageText,
    userId,
    agentId,
    undefined,
    humanAgentIdForMessage
  );

  if (humanAgentIdForMessage) {
    await systemMessage.populate("humanAgentId", "name avatar isClient");
  }

  const systemMessageObj = systemMessage.toObject ? systemMessage.toObject() : systemMessage;

  // conversation-${conversationId}  → client/agent sockets (joined via set-conversation-id)
  // conversation-${visitorId}       → legacy alias some sockets may use
  // visitor-${agentId}-${visitorId} → the actual room the visitor widget socket joins
  const agentRooms = [`conversation-${conversationId}`, `conversation-${visitorId}`];
  const visitorRoom = `visitor-${agentId}-${visitorId}`;

  io.to(`conversation-${conversationId}`).emit("conversation-append-message", { chatMessage: systemMessageObj });

  io.to(`conversation-${conversationId}`).emit("ai-chat-status-update", {
    aiChat: false,
    conversationId,
    transferredTo: transferName,
    humanAgentId: humanAgentIdForMessage,
  });

  return systemMessageObj;
}

const initializeClientEvents = (io, socket) => {
  const { humanAgentId } = socket;
  const { userId } = socket;
  const { agentId } = socket;
  let conversationRoom = "";
  let userAgentRoom = "";
  let userRoom = "";

  userAgentRoom = `user-${agentId}-${humanAgentId}`;
  userRoom = `user-${userId}`;
  const agentRoom = agentId ? `user-${agentId}` : null;

  socket.join(userAgentRoom);
  if (agentRoom) socket.join(agentRoom);
  // Rooms used by appEvents userEvent (e.g. client-status-updated, client-profile-updated)
  socket.join(userRoom);
  socket.join(`user-${humanAgentId}`);

  socket.on("client-connect", async () => {
    socket.emit("client-connect-response", {
      response: "Client Connect Successful",
    });
  });

  socket.on("get-agent-data", async () => {
    const agentData = await Agent.findOne({ _id: agentId });
    socket.emit("get-agent-data-response", {
      response: "Received data from message",
      agentData,
    });
  });

  socket.on("get-client-data", async () => {
    const clientData = await Client.findOne({ userId: userId });
    socket.emit("get-client-data-response", {
      response: "Received data from message",
      clientData,
    });
  });

  socket.on("get-training-list", async (data) => {
    const { skip, limit, sourcetype, actionType, search } = data;
    let status = actionType;
    let type = sourcetype;
    const webPages = await ScrappingController.getScrapingHistoryBySocket(
      userId,
      agentId,
      skip,
      limit,
      type,
      status,
      search
    );
    socket.emit("get-training-list-response", {
      response: "Received data from message",
      data: webPages,
    });
  });

  socket.on("continue-scrapping-button", async () => {
    const clientData = await Client.findOne({ userId });
    const agentData = await Agent.findOne({ _id: agentId });
    if (
      agentData?.pagesAdded?.success + agentData?.pagesAdded?.failed <
        agentData?.pagesAdded?.total &&
      clientData?.upgradePlanStatus?.storageLimitExceeded != true &&
      agentData?.dataTrainingStatus == 0
    ) {
      socket.emit("show-continue-scrapping-button", {
        response: "show button",
      });
    }
  });

  socket.on("get-open-conversations-list", async (data) => {
    try {
      const conv = await Conversation.find({
        userId: userId,
        agentId: agentId,
        is_started: true,
        conversationOpenStatus: "open",
      })
        .populate("humanAgentId", "name avatar isClient")
        .sort({ createdAt: -1 });

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
        agentId: agentId,
        conversationOpenStatus: "close",
      })
        .populate("humanAgentId", "name avatar isClient")
        .sort({ createdAt: -1 });

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
      if (conversationRoom) {
        socket.leave(conversationRoom);
      }
      conversationRoom = `conversation-${conversationId}`;
      await socket.join(conversationRoom);
      if (typeof callback === "function") {
        callback({ success: true });
      }
    } catch (error) {
      console.error("set-conversation-id error:", error.message);
      if (typeof callback === "function") {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on("check-pending-agent-request", async ({ conversationId }, callback) => {
    try {
      const entry = getAgentConnectionEntry(conversationId);
      const hasPendingRequest = !!entry;

      if (hasPendingRequest) {
        const conversation = await Conversation.findById(conversationId).lean();
        if (conversation && conversation.aiChat === true) {
          const visitor = await Visitor.findById(conversation.visitor).lean();

          const notificationData = {
            conversationId,
            visitorId: conversation.visitor,
            visitor: visitor,
            message: "Visitor requested to connect to an agent",
            timestamp: new Date(),
            requestStartedAt: entry.requestStartedAt,
          };

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

  // Typing events — aiChat guard is enforced on the client side (isAIChat state).
  // No DB fetch needed here; client passes aiChat status in the payload.
  socket.on("agent-start-typing", async ({ conversationId, visitorId, aiChat }, callback) => {
    try {
      if (aiChat === false) {
        io.to([
          `conversation-${conversationId}`,
          // `visitor-${agentId}-${visitorId}`,
        ]).emit("agent-typing", { conversationId, visitorId });
      }
      callback?.({ success: true });
    } catch (error) {
      console.error("agent-start-typing error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("agent-stop-typing", async ({ conversationId, visitorId, aiChat }, callback) => {
    try {
      if (aiChat === false) {
        io.to([
          `conversation-${conversationId}`,
          // `visitor-${agentId}-${visitorId}`,
        ]).emit("agent-stop-typing", { conversationId, visitorId });
      }
      callback?.({ success: true });
    } catch (error) {
      console.error("agent-stop-typing error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("client-send-message", async ({ message, visitorId, conversationId: payloadConversationId, replyTo }, callback) => {
    try {
      // Use the explicit conversationId from the frontend when available so the
      // message always targets the correct conversation (important when a visitor
      // has multiple open conversations). Fall back to a lookup for backwards compat.
      let conversation;
      if (payloadConversationId) {
        conversation = await Conversation.findById(payloadConversationId);
      }
      if (!conversation) {
        conversation = await ConversationController.getOpenConversationForAgent(
          visitorId,
          userId,
          agentId
        );
      }
      const conversationId = conversation?._id || null;

      const { id: humanAgentIdForMessage } = await resolveHumanAgent(socket, userId);

      const senderType = socket.type === "client" ? "client" : "humanAgent";
      const chatMessage = await ChatMessageController.createChatMessage(
        conversationId,
        visitorId,
        senderType,
        message,
        userId,
        agentId,
        undefined,
        humanAgentIdForMessage,
        replyTo
      );

      if (humanAgentIdForMessage) {
        await chatMessage.populate("humanAgentId", "name avatar isClient");
      }
      await chatMessage.populate("agentId", "agentName");
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

      const chatMessageObj = chatMessage.toObject ? chatMessage.toObject() : chatMessage;

      await Conversation.updateOne(
        { _id: conversationId },
        { $set: { lastMessage: stripHtml(message) } }
      );

      // const visitorRoom = `visitor-${agentId}-${visitorId}`;

      // Use the conversation already fetched above — no second DB call needed
      if (conversation && !conversation.aiChat) {
        io.to([
          `conversation-${conversationId}`,
          // visitorRoom,
        ]).emit("agent-stop-typing", { conversationId, visitorId });
      }

      io.to([
        `conversation-${conversationId}`,
        // visitorRoom,
      ]).emit("conversation-append-message", { chatMessage: chatMessageObj });

      callback?.({ success: true, chatMessage: chatMessageObj });
    } catch (error) {
      console.error("client-send-message error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("client-send-add-note", async ({ message, visitorId, conversationId, replyTo }, callback) => {
    try {
      const { id: humanAgentIdForMessage } = await resolveHumanAgent(socket, userId);

      const noteSenderType = socket.type === "client" ? "client" : "humanAgent";
      const note = await ChatMessageController.addNoteToChat(
        visitorId,
        noteSenderType,
        message,
        conversationId,
        userId,
        agentId,
        humanAgentIdForMessage,
        replyTo
      );

      if (humanAgentIdForMessage) {
        await note.populate("humanAgentId", "name avatar isClient");
      }
      if (replyTo) {
        await note.populate({
          path: "replyTo",
          select: "sender message createdAt sender_type humanAgentId",
          populate: { path: "humanAgentId", select: "name isClient" },
        });
      }

      const noteObj = note.toObject ? note.toObject() : note;

      io.to(`conversation-${conversationId}`).emit("note-append-message", { note: noteObj });

      callback?.({ success: true, note: noteObj });
    } catch (error) {
      console.error("client-send-add-note error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("get-all-note-messages", async ({ conversationId }, callback) => {
    try {
      const notes = await ChatMessageController.getAllChatNotesMessages(conversationId);
      callback?.({ success: true, notes: notes });
    } catch (error) {
      console.error("get-all-note-messages error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("get-visitor-old-conversations", async ({ visitorId }, callback) => {
    try {
      const conversations = await ConversationController.getAllOldConversations(visitorId);
      callback?.({ success: true, conversations: conversations });
    } catch (error) {
      console.error("get-visitor-old-conversations error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("add-conversation-tag", async ({ name, conversationId }, callback) => {
    try {
      const updatedTags = await ConversationTagController.createTag({
        name,
        conversationId,
        userId,
        agentId,
      });
      callback({ success: true, tags: updatedTags });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("get-conversation-tags", async ({ conversationId }, callback) => {
    try {
      const tags = await ConversationTagController.getAllTagsOfConversation({ conversationId });
      io.to(`conversation-${conversationId}`).emit("get-tags-response", { tags });
      if (typeof callback === "function") {
        callback({ success: true, tags });
      }
    } catch (error) {
      console.error("get-conversation-tags error:", error.message);
      if (typeof callback === "function") {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on("remove-conversation-tag", async ({ id, conversationId }, callback) => {
    try {
      const updatedTags = await ConversationTagController.deleteTagById({ id });
      callback({ success: true, tags: updatedTags });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("close-conversation", async ({ conversationId, status }, callback) => {
    try {
      let conversation = await Conversation.findOne({
        _id: conversationId,
        conversationOpenStatus: "open",
      });

      if (!conversation) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Conversation not found or already closed" });
        }
        return;
      }

     if(status === "close" && conversation.visitorClosed === false){
      try {
        await transcriptEmailQueue.add("sendConversationTranscriptEmail", { conversation: conversation.toObject() });
      } catch (mailError) {
        console.error("queue transcript email error:", mailError.message);
      }
     }

      let visitorId = conversation?.visitor;

      const { name: closedByName } = await resolveHumanAgent(socket, userId);
      await ConversationController.UpdateConversationStatusOpenClose(
        conversationId,
        status,
        status === "close" ? closedByName : undefined
      );

      if (status === "close") {
        await appendConversationClosedSystemMessage(io, {
          conversationId,
          visitorId,
          userId,
          agentId: conversation.agentId || agentId,
          closedByName,
        });
      }

      // Emit only to userAgentRoom — client socket is also in conversation-{id} room
      // (joined via set-conversation-id) so emitting to both would deliver it twice.
      io.to([conversationRoom]).emit("conversation-close-triggered", {
        conversationStatus: "close",
      });

      io.to(conversationRoom).emit("visitor-conversation-close", {
        conversationStatus: "close",
      });

      if (typeof callback === "function") {
        callback({ success: true });
      }
    } catch (error) {
      console.error("close-conversation error:", error.message);
      if (typeof callback === "function") {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on("block-visitor", async ({ visitorId, conversationId }, callback) => {
    try {
      await VisitorController.blockVisitor({ visitorId });

      const { name: closedByName } = await resolveHumanAgent(socket, userId);
      await ConversationController.UpdateConversationStatusOpenClose(
        conversationId,
        "close",
        closedByName
      );

      const conv = await Conversation.findById(conversationId).lean();
      if (conv) {
        await appendConversationClosedSystemMessage(io, {
          conversationId,
          visitorId: conv.visitor,
          userId: conv.userId,
          agentId: conv.agentId || agentId,
          closedByName,
        });
      }

      // Emit only to userAgentRoom to avoid double delivery (client is in both rooms)
      io.to([conversationRoom]).emit("conversation-close-triggered", {
        conversationStatus: "close",
      });

      io.to(conversationRoom).emit("visitor-blocked", {
        conversationStatus: "close",
      });

      if (typeof callback === "function") {
        callback({ success: true });
      }
    } catch (error) {
      console.error("block-visitor error:", error.message);
      if (typeof callback === "function") {
        callback({ success: false, error: error.message });
      }
    }
  });

  socket.on("agent-deleted", async ({}, callback) => {
    try {
      io.to(userRoom).emit("agent-deleted-success");
    } catch (error) {
      console.error("agent-deleted error:", error.message);
    }
  });

  socket.on("close-ai-response", async ({ conversationId }, callback) => {
    try {
      const conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      if (!conversation.aiChat) {
        callback?.({ success: true, message: "AI chat already disabled" });
        return;
      }

      const visitorId = conversation?.visitor;

      const { id: humanAgentIdForMessage, name: transferName } = await resolveHumanAgent(socket, userId);

      await transferChatToHuman(io, {
        conversationId,
        visitorId,
        humanAgentIdForMessage,
        transferName,
        userId,
        agentId,
        systemMessageText: `The chat is transferred to ${transferName}`,
      });

      callback?.({ success: true });
    } catch (error) {
      console.error("close-ai-response error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("search-conversations", async ({ query }, callback) => {
    try {
      const visitors = await ConversationController.searchByTagOrName(query, userId, agentId);
      callback({ success: true, data: visitors });
    } catch (error) {
      console.error("Error during search:", error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on("get-filtered-conversations-list", async ({ status, rating, handledBy }, callback) => {
    try {
      const query = {
        userId: userId,
        agentId: agentId,
      };

      if (status && status !== "all") {
        query.conversationOpenStatus = status;
      }

      if (rating === "good") {
        query.feedback = true;
      } else if (rating === "bad") {
        query.feedback = false;
      }

      if (handledBy === "ai") {
        query.aiChat = true;
      }

      const conv = await Conversation.find(query)
        .populate("humanAgentId", "name avatar isClient")
        .sort({ createdAt: -1 });

      const updatedVisitors = await Promise.all(
        conv.map(async (conv) => {
          const conversation = conv.toObject();
          const visitor = await Visitor.findOne({ _id: conv.visitor });
          conversation["visitor"] = visitor;
          return conversation;
        })
      );

      callback?.({ success: true, conversations: updatedVisitors });
    } catch (error) {
      console.error("Error fetching filtered conversations list:", error);
      callback?.({ success: false, error: error.message });
    }
  });

  ///////dashboard////////////
  socket.on("fetch-dashboard-data", async ({ dateRange,agentId }, callback) => {
    try {
      const [data, analytics, plan, effectiveLimits] = await Promise.all([
        DashboardController.getDashboardDataForAgent(dateRange, socket.userId, agentId),
        DashboardController.getUsageAnalytics(socket.userId),
        PlanService.getUserPlan(socket.userId),
        PlanService.getEffectiveLimits(socket.userId),
      ]);
      callback({ success: true, data, analytics, plan, effectiveLimits });
    } catch (error) {
      console.error("Error fetching dashboard data:", error);
      callback({ success: false, error: "Failed to fetch data" });
    }
  });
  ////////////////dash end///////////

  /////// effective limits ///////
  socket.on("fetch-effective-limits", async ({ }, callback) => {
    try {
      const [effectiveLimits] = await Promise.all([
        PlanService.getEffectiveLimits(socket.userId),
      ]);
      callback?.({ success: true , effectiveLimits: effectiveLimits });
    } catch (error) {
      console.error("Error fetching effective limits:", error);
      callback?.({ success: false, error: "Failed to fetch effective limits" });
    }
  });

  socket.on("accept-agent-connection", async ({ conversationId }, callback) => {
    try {
      const conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        callback?.({ success: false, error: "Conversation not found" });
        return;
      }

      if (!conversation.aiChat) {
        callback?.({ success: true, message: "Already connected to agent" });
        return;
      }

      const visitorId = conversation?.visitor;

      const { id: humanAgentIdForMessage, name: transferName } = await resolveHumanAgent(socket, userId);

      await transferChatToHuman(io, {
        conversationId,
        visitorId,
        humanAgentIdForMessage,
        transferName,
        userId,
        agentId,
        systemMessageText: `Connected to ${transferName}`,
      });

      // Notify visitor that agent accepted.
      // Visitor sockets join visitor-${agentId}-${visitorId}, NOT conversation rooms.
      io.to(conversationRoom).emit("agent-connection-accepted", {
        conversationId,
        agentName: transferName,
      });

      // Clear the pending timeout.
      const pending = getAgentConnectionEntry(conversationId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        agentConnectionTimeouts.delete(conversationId.toString());
      }

      callback?.({ success: true });
    } catch (error) {
      console.error("accept-agent-connection error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("decline-agent-connection", async ({ conversationId }, callback) => {
    try {
      // Emit only to THIS socket so only the declining agent dismisses the request.
      // Other agents should continue seeing the request until it times out or is accepted.
      socket.emit("agent-connection-cancelled", { conversationId });
      callback?.({ success: true });
    } catch (error) {
      console.error("decline-agent-connection error:", error.message);
      callback?.({ success: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    if (userAgentRoom) socket.leave(userAgentRoom);
    if (userRoom) socket.leave(userRoom);
    if (conversationRoom) socket.leave(conversationRoom);
    if (agentRoom) socket.leave(agentRoom);

    console.log("User disconnected from client socket");
  });
};

module.exports = {
  initializeClientEvents,
};
