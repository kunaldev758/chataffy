const jwt = require("jsonwebtoken");

const { encode } = require("html-entities");
const { JSDOM } = require("jsdom");
const { Node, document } = new JSDOM("").window;

const SocketController = {};
const CreditsController = require("../controllers/CreditsController");
const OpenaiTrainingListController = require("../controllers/OpenaiTrainingListController");
const OpenaiChatMessageController = require("../controllers/OpenaiChatMessageController");
const ChatMessageController = require("../controllers/ChatMessageController");
const VisitorController = require("../controllers/VisitorController");
const ConversationController = require("../controllers/ConversationController");
const User = require("../models/User");
const Widget = require("../models/Widget");
const Visitor = require("../models/Visitor");
const Conversation = require("../models/Conversation");
const ConversationTagController = require("../controllers/ConversationTagController");
const DashboardController = require('../controllers/DashboardController');

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
// Middleware function
const myMiddleware = async (socket, next) => {
  try {
    const { token, visitorId,widgetId,widgetAuthToken,conversationId } =
      socket.handshake.query;

    socket.conversationId = conversationId;

    if (token && !widgetId) {
      // Client Authentication
      const decoded = await verifyToken(token);
      if (!decoded) throw new Error("Invalid token.");

      const user = await User.findById(decoded._id);
      if (!user || user.auth_token !== token)
        throw new Error("User not found or token mismatch.");

      socket.userId = user._id;
      socket.type = "client";
    } else if (visitorId && widgetId && widgetAuthToken) {
      // Visitor Authentication
      const widget = await Widget.findOne({
        _id: widgetId,
        widgetToken: widgetAuthToken,
      });
      if (!widget) throw new Error("Widget authentication failed.");

      socket.userId = widget.userId;
      socket.type = "visitor";

      if (visitorId && visitorId !='undefined') {
        const visitor = await Visitor.findOne({visitorId:visitorId});
        socket.visitorId =
          visitor && visitor.userId.toString() === socket.userId.toString()
            ? visitor._id
            : (await VisitorController.createVisitor(socket.userId,visitorId))._id;
      } else {
        const visitor = await VisitorController.createVisitor(socket.userId,visitorId)
        socket.visitorId = visitor._id
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

SocketController.handleSocketEvents = (io) => {
  io.use(myMiddleware);

  io.on("connection", (socket) => {
    const { type, userId, visitorId,conversationId } = socket;

    if (type === "client") {
      // Join client to their unique room
      const conversationRoom = `conversation-${conversationId}`
      const clientRoom = `user-${userId}`;
      socket.join(clientRoom);
      socket.join(conversationRoom);

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
        const webPagesCount = await OpenaiTrainingListController.getWebPageUrlCount(userId);
        const docSnippets = await OpenaiTrainingListController.getSnippetCount(userId);
        // {crawledDocs: 0, totalDocs: 0};
        const faqs = await OpenaiTrainingListController.getFaqCount(userId);
        // {crawledFaqs: 0,totalFaqs: 0};
        socket.emit("get-training-list-count-response", {
          response: "Received data from message",
          data: {...webPagesCount, ...docSnippets, ...faqs},
        });
      });
      socket.on("get-training-list", async (data) => {
        // const userId = socket.userId;
        const webPages = await OpenaiTrainingListController.getWebPageList(userId);
        socket.emit("get-training-list-response", {
          response: "Received data from message",
          data: webPages,
        });
      });

      socket.on("get-conversations-list", async (data) => {
        try {
          console.log("Received request for conversations list", data);
    
          // Fetch the conversations list from your database
          // const conversations = await getConversationsForUser(data.userId);
          const visitors = await Visitor.find({
            userId,
            // lastMessage: { $exists: true },
          }).sort({ createdAt: -1 });
          const updatedVisitors = await Promise.all(
            visitors.map(async (visitorDoc) => {
              const visitor = visitorDoc.toObject(); // Convert to plain object
              const conv = await Conversation.findOne({
                visitor: visitor._id,
                // conversationOpenStatus: "open",
              });
              visitor["conversation"] = conv;
              return visitor; // Return modified visitor
            })
          );
    
          // Emit the response back to the frontend
          socket.emit("get-conversations-list-response", {
            status: "success",
            conversations:updatedVisitors,
          });
        } catch (error) {
          console.error("Error fetching conversations list:", error);
    
          // Emit an error response
          socket.emit("get-conversations-list-response", {
            status: "error",
            message: "Failed to fetch conversations list",
          });
        }
      });

      socket.on("client-send-message", async ({ message, visitorId }, callback) => {
          try {
            const conversation =
              await ConversationController.getOpenConversation(visitorId);
            const conversationId = conversation?._id || null;

            const chatMessage =
              await OpenaiChatMessageController.createChatMessage(
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

      socket.on("client-send-add-note", async ({ message, visitorId, conversationId }, callback) => {
          try {
            const note = await ChatMessageController.addNoteToChat(
              visitorId,
              "agent",
              message,
              conversationId,
              userId,
            );
            callback?.({ success: true, note });
          } catch (error) {
            console.error("client-send-add-note error:", error.message);
            callback?.({ success: false, error: error.message });
          }
        }
      );

      socket.on("get-all-note-messages", async ({ conversationId }, callback) => {
          try {
            const notes =await ChatMessageController.getAllChatNotesMessages(conversationId)
            callback?.({ success: true, notes:notes });
          } catch (error) {
            console.error("get-all-note-messages error:", error.message);
            callback?.({ success: false, error: error.message });
          }
        }
      );

      socket.on("get-visitor-old-conversations", async ({ visitorId }, callback) => {
          try {
            const conversations =await ConversationController.getAllOldConversations(visitorId)
            callback?.({ success: true, conversations:conversations });
          } catch (error) {
            console.error("get-visitor-old-conversations error:", error.message);
            callback?.({ success: false, error: error.message });
          }
        }
      );

      socket.on("add-conversation-tag", async ({ name, conversationId }, callback) => {
          try {
            const updatedTags = await ConversationTagController.createTag({
              name,
              conversationId,
            }); // Replace with your DB logic
            callback({ success: true, tags: updatedTags });
          } catch (error) {
            callback({ success: false, error: error.message });
          }
        }
      );

      socket.on("get-conversation-tags", async ({ conversationId }, callback) => {
          try {
            const tags =
              await ConversationTagController.getAllTagsOfConversation({
                conversationId,
              }); // Replace with your DB logic
            callback({ success: true, tags });
          } catch (error) {
            callback({ success: false, error: error.message });
          }
        }
      );

      socket.on("remove-conversation-tag", async ({ id, conversationId }, callback) => {
          try {
            const updatedTags = await ConversationTagController.deleteTagById({
              id,
            }); // Replace with your DB logic
            callback({ success: true, tags: updatedTags });
          } catch (error) {
            callback({ success: false, error: error.message });
          }
        }
      );

      socket.on("close-conversation", async ({ conversationId, status }, callback) => {
          try {
            await ConversationController.UpdateConversationStatusOpenClose(
              conversationId,
              status,
            ); // Replace with your DB logic
            callback({ success: true });
          } catch (error) {
            callback({ success: false, error: error.message });
          }
        }
      );

      socket.on("block-visitor", async ({ visitorId }, callback) => {
        try {
          await VisitorController.blockVisitor({ visitorId }); // Replace with your DB logic
          callback({ success: true });
          io.to(conversationRoom).emit('visitor-blocked', {conversationStatus:'close' });
        } catch (error) {
          callback({ success: false, error: error.message });
        }
      });

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
          console.log("Search Query Received:", query);

          const visitors = await Visitor.find({
            userId,
            name:query
            // lastMessage: { $exists: true },
          }).sort({ createdAt: -1 });
          const updatedVisitors = await Promise.all(
            visitors.map(async (visitorDoc) => {
              const visitor = visitorDoc.toObject(); // Convert to plain object
              const conv = await Conversation.findOne({
                visitor: visitor._id,
                // conversationOpenStatus: "open",
              });
              visitor["conversation"] = conv;
              // console.log(visitor,"visitor data list")
              return visitor; // Return modified visitor
            })
          );
          // Perform the search in your database
          // const searchResults = await ConversationController.searchByTagOrName(
          //   query
          // ); // Replace with your DB logic

          callback({ success: true, data: updatedVisitors });
        } catch (error) {
          console.error("Error during search:", error);
          callback({ success: false, error: error.message });
        }
      });

      ///////dashboard////////////
      socket.on("fetch-dashboard-data", async ({ dateRange }, callback) => {
        try {
          // Fetch data from the database based on date range
          const data = await DashboardController.getDashboardData(dateRange); // Replace with actual DB logic
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

      socket.on("disconnect", () => {socket.leave(clientRoom);
        socket.leave(conversationRoom)});
    }

    if (type === "visitor") {

      const VisitorRoom = `conversation-${visitorId}`;
      const conversationRoom = `conversation-${conversationId}`
  
      socket.join(conversationRoom);
      socket.join(VisitorRoom);

      socket.on("visitor-connect", async ({ widgetToken }) => {
        try {
          // Fetch theme settings for the widget
          const themeSettings = await Widget.findOne({ widgetToken });
    
          // Fetch the visitor's conversation history
          let chatMessages = [];
          chatMessages = await ChatMessageController.getAllChatMessages(visitorId);

          if(chatMessages.length <=0){
            const conversation = await ConversationController.getOpenConversation(
              visitorId
            );
            const conversationId = conversation?._id || null;
          
          await OpenaiChatMessageController.createChatMessage(
            conversationId,
            visitorId,
            "bot",
            themeSettings?.welcomeMessage,
            userId
          );

          chatMessages = await ChatMessageController.getAllChatMessages(visitorId);

          io.to(conversationRoom).emit('visitor-connect-list-update', {});
          }
    
          // Emit visitor-connect-response with visitor data
          socket.emit("visitor-connect-response", {
            // visitorId: visitor.visitorId,
            chatMessages,
            themeSettings,
          });
    
          // console.log(`Visitor connected: ${visitor.visitorId}`);
        } catch (error) {
          console.error("Error handling visitor-connect:", error);
          socket.emit("error", { message: "Failed to connect visitor" });
        }
      });

      socket.on("save-visitor-details",async({location,ip,visitorDetails},callback)=>{
        try{
          await VisitorController.updateVisitorById({id:visitorId,location,ip,visitorDetails})
        }catch(error){
          console.error("save-visitor-details error:", error.message);
          callback?.({ success: false, error: error.message });
        }
      });
    

      socket.on("visitor-send-message", async ({ message, id }, callback) => {
        try {
          const conversation = await ConversationController.getOpenConversation(
            visitorId
          );
          const conversationId = conversation?._id || null;

          // const chatMessage =
          //   await OpenaiChatMessageController.createChatMessage(
          //     conversationId,
          //     visitorId,
          //     "visitor",
          //     message,
          //     userId
          //   );
            const encodedMessage = encode(message);
          let chatMessage = await OpenaiChatMessageController.createChatMessage(conversationId, visitorId, 'visitor', "<p>"+encodedMessage+"</p>",userId);

          io.to(`conversation-${conversationId}`).emit("conversation-append-message", {
            chatMessage,
          });
          callback?.({ success: true, chatMessage, id });
         if(conversation.aiChat){
            response_data = await OpenaiChatMessageController.chat_message_response(chatMessage, visitorId, conversationId, io, userId);
            io.to(`conversation-${visitorId}`).emit('intermediate-response', {message:"...replying"});
            io.to(`conversation-${conversationId}`).emit('intermediate-response', {message:"...replying"});

            if(response_data.error) {
              // io.to("visitor"+socket.visitorId).emit('chat-response-error', {"message_for": "abcd", "error": "Error in response"});
              const chatMessageResponse = await OpenaiChatMessageController.createChatMessage(conversationId, visitorId, 'bot-error', "Error in response",userId);
              io.to(`conversation-${visitorId}`).emit('conversation-append-message', {"chatMessage":chatMessageResponse});
              io.to(`conversation-${conversationId}`).emit('conversation-append-message', {"chatMessage":chatMessageResponse });
              // response_data.error
            }
            else {
              const chatMessageResponse = await OpenaiChatMessageController.createChatMessage(conversationId, visitorId, 'bot', response_data.reply,userId, response_data.infoSources);
              io.to(`conversation-${visitorId}`).emit('conversation-append-message', {"chatMessage":chatMessageResponse, sources: response_data.sources });
              io.to(`conversation-${conversationId}`).emit('conversation-append-message', {"chatMessage":chatMessageResponse, sources: response_data.sources });
              // io.to(conversationId).emit('newChatMessage', chatMessage);
            }
          }
          
        } catch (error) {
          console.error("visitor-send-message error:", error.message);
          callback?.({ success: false, error: error.message });
        }
      });

      socket.on("message-feedback", async ({ messageId, feedback }, callback) => {
          try {
            const updatedMessage = await ChatMessageController.updateFeedback(
              messageId,
              feedback
            );
            callback?.({ success: true, updatedMessage });
          } catch (error) {
            console.error("message-feedback error:", error.message);
            callback?.({ success: false, error: error.message });
          }
        }
      );

      socket.on("close-conversation",async ({ conversationId, status }, callback) => {
          try {
            await ConversationController.UpdateConversationStatusOpenClose(
              conversationId,
              status
            );
            callback?.({ success: true });
            io.to(conversationRoom).emit('visitor-close-chat', {conversationStatus:'close' });
          } catch (error) {
            console.error("close-conversation error:", error.message);
            callback?.({ success: false, error: error.message });
          }
        }
      );

      socket.on("disconnect", () => {
        socket.leave(VisitorRoom);
        socket.leave(conversationRoom);
      });
    }
  });
};


module.exports = SocketController;
