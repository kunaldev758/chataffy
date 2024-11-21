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
  // console.log("Middleware",socket.handshake.query);
  const isUserConnection =
    socket.handshake.query.token !== undefined &&
    socket.handshake.query.embedType !== undefined;
  const isVisitorConnection =
    socket.handshake.query.widgetId !== undefined &&
    socket.handshake.query.widgetAuthToken !== undefined &&
    socket.handshake.query.embedType !== undefined;
  try {
    if (isUserConnection) {
      // User authentication with JWT token
      const token = socket.handshake.query.token;
      const decoded = await verifyToken(token);
      if (decoded) {
        const userId = decoded._id;
        const user = await User.findById(userId);
        if (user && user.auth_token == token) {
          socket.userId = userId;
          socket.type = "client";
          socket.embedType = socket.handshake.query.embedType;
        } else {
          throw new Error("User authentication failed. User not found.");
        }
      } else {
        throw new Error("User authentication failed. Invalid token.");
      }
    } else if (isVisitorConnection) {
      const widgetId = socket.handshake.query.widgetId;
      const widgetToken = socket.handshake.query.widgetAuthToken;
      const widget = await Widget.findOne({ _id: widgetId, widgetToken });
      if (widget) {
        socket.userId = widget.userId;
        socket.type = "visitor";
        socket.embedType = socket.handshake.query.embedType;
      } else {
        throw new Error("Visitor authentication failed. Widget not found.");
      }
      try {
        if (socket.handshake.query.visitorId !== undefined) {
          const visitorId = socket.handshake.query.visitorId;
          const visitor = await Visitor.findById(visitorId);
          // console.log("visitor", visitor);
          if (
            !visitor ||
            visitor.userId.toString() != socket.userId.toString()
          ) {
            const newVisitor = await VisitorController.createVisitor(
              socket.userId
            );
            socket.visitorId = newVisitor._id;
          } else {
            socket.visitorId = visitorId;
          }
        } else {
          const newVisitor = await VisitorController.createVisitor(
            socket.userId
          );
          socket.visitorId = newVisitor._id;
          const io = socket.server;
          // console.log(newVisitor, io,socket.userId);
          io.to("user" + socket.userId).emit("conversations-list-update", {
            data: newVisitor,
          });
        }
      } catch (error) {
        const newVisitor = await VisitorController.createVisitor(socket.userId);
        socket.visitorId = newVisitor._id;
        const io = socket.server;
        // console.log(newVisitor, io,socket.userId);
        io.to("user" + socket.userId).emit("conversations-list-update", {
          data: newVisitor,
        });
      }
    } else {
      throw new Error(
        "Invalid connection type. Please provide valid credentials."
      );
    }
    next();
  } catch (error) {
    socket.emit("error-handler", {
      status_code: 401,
      message: error.message || "Authentication failed.",
    });
    // next(new Error("Authentication failed."));
    next();
  }
};

// Socket event handlers
SocketController.handleSocketEvents = (io) => {
  io.use(myMiddleware);
  io.on("connection", (socket) => {
    if (socket.type == "client") {
      socket.on("client-connect", async (data) => {
        const userId = socket.userId;
        socket.join("user" + userId);
        socket.emit("client-connect-response", {
          response: "Received data from message",
          data,
        });
      });
      /*---------------*/
      if (socket.embedType == "openai") {
        console.log("client using openai");
        socket.on("get-credit-count", async (data) => {
          const userId = socket.userId;
          const credits = await CreditsController.getUserCredits(userId);
          socket.emit("get-credit-count-response", {
            response: "Received data from message",
            data: credits,
          });
        });
        socket.on("get-training-list-count", async (data) => {
          const userId = socket.userId;
          const webPagesCount =
            await OpenaiTrainingListController.getWebPageUrlCount(userId);
          const docSnippets =
            await OpenaiTrainingListController.getSnippetCount(userId);
          // {crawledDocs: 0, totalDocs: 0};
          const faqs = await OpenaiTrainingListController.getFaqCount(userId);
          // {crawledFaqs: 0,totalFaqs: 0};
          socket.emit("get-training-list-count-response", {
            response: "Received data from message",
            data: { ...webPagesCount, ...docSnippets, ...faqs },
          });
        });
        socket.on("get-training-list", async (data) => {
          const userId = socket.userId;
          const webPages = await OpenaiTrainingListController.getWebPageList(
            userId
          );
          socket.emit("get-training-list-response", {
            response: "Received data from message",
            data: webPages,
          });
        });
        socket.on("get-conversations-list", async (data) => {
          const userId = socket.userId;
          const visitors = await Visitor.find({
            userId,
            // lastMessage: { $exists: true },
          }).sort({ createdAt: -1 });
          const updatedVisitors = await Promise.all(
            visitors.map(async (visitorDoc) => {
              const visitor = visitorDoc.toObject(); // Convert to plain object
              const conv = await Conversation.findOne({
                visitor: visitor._id,
                conversationOpenStatus: "open",
              });
              visitor["conversation"] = conv;
              // console.log(visitor,"visitor data list")
              return visitor; // Return modified visitor
            })
          );
          console.log(updatedVisitors, "Visitors List");
          socket.emit("get-conversations-list-response", {
            response: "Received data from message",
            data: updatedVisitors,
          });
        });
      }

      // New Event: Client sends a response to a visitor
      socket.on("client-send-message", async (data, callback) => {
        // const conversationId = socket.conversationId;
        const { message, visitorId } = data;
        let conversation = await ConversationController.getOpenConversation(
          visitorId
        );
        let conversationId = conversation._id ? conversation._id : null;
        try {
          // Save the client message in the chat history
          const chatMessage =
            await OpenaiChatMessageController.createChatMessage(
              conversationId,
              visitorId,
              "agent",
              message
            );
          chatMessages = await OpenaiChatMessageController.getAllChatMessages(
            conversationId
          );
          const div = document.createElement("div");
          div.innerHTML = chatMessage;

          // Emit the message to the visitor and other participants in the conversation
          io.to("conversation" + visitorId).emit(
            "conversation-append-message",
            { chatMessage: chatMessage }
          );
        } catch (error) {
          // Handle client-send-message error
          console.log("client-send-message-error:", error.message);
          socket.emit("client-send-message-error", error.message);
        }
      });

      socket.on("client-send-add-note", async (data, callback) => {
        const userId = socket.userId;
        const { message, visitorId, conversationId } = data;
        try {
          // Save the client message in the chat history
          const chatMessage = await ChatMessageController.addNoteToChat(
            visitorId,
            "agent",
            message,
            conversationId
          );
          chatMessages = await OpenaiChatMessageController.getAllChatMessages(
            conversationId
          );
          const div = document.createElement("div");
          div.innerHTML = chatMessage;

          // Emit the message to the visitor and other participants in the conversation
          io.to("conversation" + visitorId).emit(
            "conversation-append-message",
            { chatMessage: chatMessage }
          );
        } catch (error) {
          // Handle client-send-message error
          console.log("client-send-message-error:", error.message);
          socket.emit("client-send-message-error", error.message);
        }
      });

      /*----------------*/
      socket.on("disconnect", () => {
        const userId = socket.userId;
        socket.leave("user" + userId);
      });
    }

    /* Visitor */
    if (socket.type == "visitor") {
      if (socket.embedType == "openai") {
        socket.on("visitor-connect", async (data) => {
          try {
            let visitorId = socket.visitorId;
            let conversation = await ConversationController.getOpenConversation(
              visitorId
            );
            let conversationId = conversation != null ? conversation.id : null;

            if (!conversationId) {
              conversation = await ConversationController.createConversation(
                visitorId
              );
              conversationId = conversation._id;
            }

            chatMessages = [];
            chatMessages = await OpenaiChatMessageController.getAllChatMessages(
              conversationId
            );
            if (!chatMessages.length) {
              const chatMessage =
                await OpenaiChatMessageController.createChatMessage(
                  conversationId,
                  visitorId,
                  "system",
                  "Conversation start"
                );

              chatMessages = [chatMessage];
            }
            socket.visitorId = visitorId;
            socket.conversationId = conversationId;
            socket.type = "visitor";
            socket.join("visitor" + visitorId);
            socket.join("conversation" + conversationId);
            socket.emit("visitor-connect-response", {
              visitorId,
              conversationId: conversationId,
              chatMessages,
            });
          } catch (error) {
            socket.emit("visitor-connect-error", error.message);
          }
        });

        // Handle events when a client sends a message
        socket.on("visitor-send-message", async (data, callback) => {
          const { message, id } = data;
          const { visitorId, conversationId } = socket;
          const encodedMessage = encode(message);
          let response_data,
            chatMessage = null;
          try {
            chatMessage = await OpenaiChatMessageController.createChatMessage(
              conversationId,
              visitorId,
              "visitor",
              "<p>" + encodedMessage + "</p>"
            );
            io.to("conversation" + conversationId).emit(
              "conversation-append-message",
              { chatMessage: chatMessage, id }
            );
          } catch (error) {
            console.log("visitor-send-message-error");
            socket.emit("visitor-send-message-error", error.message);
          }
          // callback
          if (callback) {
            callback({ chatMessage, id });
          }

          try {
            let conv = await Conversation.findOne({_id:conversationId});
            if(!conv.aiChat){

            }else{
            response_data =
              await OpenaiChatMessageController.chat_message_response(
                chatMessage,
                visitorId,
                conversationId,
                io,
                socket.userId
              );
            }
            // console.log("response_data", response_data);
          } catch (error) {
            console.log("newChatMessageError");
            socket.emit("newChatMessageError", error.message);
          }
          try {
            if(conv.aiChat){
            const div = document.createElement("div");
            div.innerHTML = response_data.reply;

            if (div.childNodes.length >= 1) {
              const firstChild = div.firstChild;
              if (firstChild.nodeType === Node.TEXT_NODE) {
                const pElement = document.createElement("p");
                pElement.textContent = firstChild.textContent;
                div.replaceChild(pElement, firstChild);
              }
              const lastChild = div.lastChild;
              if (lastChild.nodeType === Node.TEXT_NODE) {
                const pElement = document.createElement("p");
                pElement.textContent = lastChild.textContent;
                div.replaceChild(pElement, lastChild);
              }
              // console.log(div.innerHTML, "div.innerHTML");
              response_data.reply = div.innerHTML;
            }
            io.to("visitor" + socket.visitorId).emit("intermediate-response", {
              message: false,
            });
            // io.to("visitor"+socket.visitorId).emit('visitor-receive-message', response_data);
            if (response_data.error) {
              // io.to("visitor"+socket.visitorId).emit('chat-response-error', {"message_for": "abcd", "error": "Error in response"});
              const chatMessageResponse =
                await OpenaiChatMessageController.createChatMessage(
                  conversationId,
                  visitorId,
                  "bot-error",
                  "Error in response"
                );
              io.to("conversation" + conversationId).emit(
                "conversation-append-message",
                { chatMessage: chatMessageResponse }
              );
              // response_data.error
            } else {
              const chatMessageResponse =
                await OpenaiChatMessageController.createChatMessage(
                  conversationId,
                  visitorId,
                  "bot",
                  response_data.reply,
                  response_data.infoSources
                );
              io.to("conversation" + conversationId).emit(
                "conversation-append-message",
                {
                  chatMessage: chatMessageResponse,
                  sources: response_data.sources,
                }
              );
              // io.to(conversationId).emit('newChatMessage', chatMessage);
            }
          }
          } catch (error) {
            console.log("Response error:- ", error.message);
            socket.emit("newChatMessageError", error.message);
          }
        });

        socket.on("message-feedback", async (data, callback) => {
          const { messageId, feedback } = data; // `messageId` is the ID of the message, `feedback` is "like" or "dislike"
          try {
            // Update the message feedback in the database
            const updatedMessage = await ChatMessageController.updateFeedback(
              messageId,
              feedback
            );
        
            // Notify clients (if needed) about the feedback update
            // io.to("conversation" + updatedMessage.conversationId).emit(
            //   "message-feedback-updated",
            //   { messageId, feedback }
            // );
        
            // Respond to the frontend with success
            if (callback) {
              callback({ success: true, updatedMessage });
            }
          } catch (error) {
            console.error("Error updating message feedback:", error.message);
            // Respond with error to the frontend
            if (callback) {
              callback({ success: false, error: error.message });
            }
          }
        });
        

        socket.on("close-conversation", async (data) => {
          const { conversationId, status } = data;
          try {
            await ConversationController.UpdateConversationStatusOpenClose(
              conversationId,
              status
            );
          } catch (err) {
            throw err;
          }
        });

        // When disconnect socket
        socket.on("disconnect", () => {
          // console.log("A visitor disconnected.", socket.id);
          const visitorId = socket.visitorId;
          const conversationId = socket.conversationId;
          socket.leave("visitor" + visitorId);
          socket.leave("conversation" + conversationId);
        });
      }
    }
  });
};

module.exports = SocketController;
