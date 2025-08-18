require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { OpenAI } = require("openai");
const ChatMessageController = require("../controllers/ChatMessageController");
const Client = require("../models/Client");
const Widget = require("../models/Widget");

const {logOpenAIUsage} = require("../services/UsageTrackingService");

// --- Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Define models used in this service
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-ada-002";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o";

// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
  url: "https://8659fcda-ff81-4896-8786-55418a544b55.eu-central-1-0.aws.cloud.qdrant.io",
  apiKey:
    process.env.QDRANT_API_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.HRXxjdjkAjB3phjpoI9inwpfxo8Bv8DjQ11EMdiUrGk",
});

class QuestionAnsweringSystem {
  constructor() {
    // Explicitly set the model in OpenAIEmbeddings
    this.embeddingModel = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
      modelName: EMBEDDING_MODEL,
    });

    this.qdrantClient = qdrantClient;
  }

  async getChatHistory(conversationId) {
    try {
      // Limit the number of messages fetched if possible at the DB level
      const messages = await ChatMessageController.getRecentChatMessages(
        conversationId
      );
      // Return only the last N messages after fetching
      return messages;
    } catch (error) {
      console.error("Error getting chat history:", error);
      // Return empty array on error to allow processing to continue if possible
      return [];
    }
  }

  formatChatHistory(messages) {
    return messages
      .map((msg) => `${msg.sender_type}: ${msg.message}`) // Assuming sender_type is 'user' or 'ai'/'assistant'
      .join("\n");
  }

  async generateAnswer(question, context, chatHistory, organisation) {
    const systemPrompt = `You are a helpful chat agent for ${organisation}.

    Behavior Guidelines:
    - Always be professional, friendly, and helpful.
    - Respond to greetings (e.g., "Hi", "Hello") with a warm, welcoming message before offering help.
    - Answer questions using the provided context related to ${organisation}.
    - If the context does not include the answer, politely say that you couldn't find the information in the knowledge base. Do not guess or fabricate answers.
    - If a question is unrelated to ${organisation} or the provided context, gently inform the user that you can only answer questions about ${organisation}.
    - If information is missing, suggest visiting the official website or contacting support for further assistance.
   
    
    Response Format:
    - Use clear and concise language.
    - Format all responses using HTML for better readability (e.g., use <p>, <ul>, <strong>).
    - Whenever possible, present your answer in concise bullet points for clarity.
    - Prioritize brief, direct responses over lengthy explanations.
    - Avoid unnecessary elaboration; focus on delivering clear, actionable information.
    Example behaviors:
    - Greeting: If the user says "Hi", respond with something like "<p>Hello! 👋 How can I assist you today regarding ${organisation}?</p>"
    
    Maintain a friendly, professional tone throughout.`;

    const userPrompt = `Context from knowledge base:\n---\n${context}\n---\n\nChat History:\n---\n${chatHistory}\n---\n\nBased on the provided context and chat history, answer the following question:\nQuestion: ${question}`;

    try {
      const response = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.5,
        max_tokens: 200,
      });

      const answer =
        response.choices[0]?.message?.content?.trim() ||
        "I apologize, I encountered an issue generating a response.";
      const usage = response.usage; // { prompt_tokens, completion_tokens, total_tokens }

      return { answer, usage };
    } catch (error) {
      console.error("Error generating answer with OpenAI:", error);
      return {
        answer:
          "I'm currently unable to generate a response due to a technical issue. Please try again later.",
        usage: null,
      };
    }
  }

  // Simplified context extraction for Qdrant results
  getRelevantContext(matches) {
    return matches
      .map((match) => {
        // Qdrant stores text in payload.text
        const text = match.payload?.text || match.payload?.pageContent || "";
        return text;
      })
      .filter((text) => text.length > 0) // Remove empty contexts
      .join("\n\n---\n\n"); // Separate contexts clearly
  }

  async queryQdrant(collectionName, queryEmbedding, topK, userId) {
    try {
      console.log(
        `Querying Qdrant collection: ${collectionName} with topK: ${topK}`
      );

      // Check if collection exists
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections.some(
        (col) => col.name === collectionName
      );

      if (!collectionExists) {
        console.error(`Qdrant collection "${collectionName}" does not exist`);
        return [];
      }

      if (userId) {
        try {
          await this.qdrantClient.createPayloadIndex(collectionName, {
            field_name: "user_id",
            field_schema: "keyword",
          });
        } catch (e) {
          // Ignore if index already exists
          if (!e.message.includes("already exists")) {
            throw e;
          }
        }
      }

      // Query Qdrant
      const searchResult = await this.qdrantClient.search(collectionName, {
        vector: queryEmbedding,
        limit: topK,
        with_payload: true,
        // Filter by user_id if it exists in the payload
        filter: userId
          ? {
              must: [
                {
                  key: "user_id",
                  match: { value: userId },
                },
              ],
            }
          : undefined,
      });

      console.log(`Qdrant search returned ${searchResult.length} results`);

      return searchResult.map((result) => ({
        id: result.id,
        score: result.score,
        metadata: result.payload || {},
        payload: result.payload || {}, // Keep original payload for compatibility
      }));
    } catch (error) {
      console.error("Error querying Qdrant:", error);

      // If it's a collection not found error, return empty results
      if (error.message && error.message.includes("not found")) {
        console.error(`Collection ${collectionName} not found in Qdrant`);
        return [];
      }

      throw new Error(`Qdrant query failed: ${error.message}`);
    }
  }

  async getAnswer(userId, question, conversationId, options = {}) {
    const { topK = 5, scoreThreshold = 0.7 } = options;

    try {
      // 1. Get Chat History
      const chatSession = await this.getChatHistory(conversationId);
      const chatHistory = this.formatChatHistory(chatSession);

      // 3. Generate Question Embedding
      const questionEmbedding = await this.embeddingModel.embedQuery(question);
      if (!questionEmbedding) {
        throw new Error("Failed to generate question embedding.");
      }

      // 4. Get Client and Widget Data
      const clientData = await Client.findOne({ userId }).lean();
      const widgetData = await Widget.findOne({ userId }).lean();

      if (!clientData || !clientData.qdrantIndexName || !clientData.qdrantIndexNamePaid) {
        throw new Error(`Qdrant collection not configured for user ${userId}`);
      }
      if (!widgetData) {
        throw new Error(`Widget data not found for user ${userId}`);
      }

      // Use the same field name for compatibility, but it represents Qdrant collection now
      
      const collectionName = clientData?.plan=='free'? clientData?.qdrantIndexName:clientData?.qdrantIndexNamePaid;

      // 5. Query Qdrant
      const queryResponse = await this.queryQdrant(
        collectionName,
        questionEmbedding,
        topK,
        userId
      );

      // Filter matches by score threshold
      const relevantMatches = queryResponse.filter(
        (match) => match.score >= scoreThreshold
      );

      console.log(
        `Qdrant query for "${question.substring(0, 30)}..." found ${
          queryResponse.length
        } matches, ${relevantMatches.length} relevant.`
      );

      let finalAnswer;
      // let completionUsage = null;

      if (relevantMatches.length === 0) {
        // Default answer when no relevant context found
        finalAnswer = `I couldn't find specific information about "${question}" in the knowledge base. You might find helpful information on the ${
          widgetData.organisation || "company"
        } website: ${widgetData.website || "(Website not provided)"}`;
      } else {
        // 6. Get Context and Generate Answer via LLM
        const context = this.getRelevantContext(relevantMatches);

        const { answer: generatedAnswer, usage: llmUsage } =
          await this.generateAnswer(
            question,
            context,
            chatHistory,
            widgetData.organisation || "the company"
          );
        finalAnswer = generatedAnswer;
        logOpenAIUsage({userId, tokens:llmUsage.total_tokens, requests:1})
      }

      // 10. Prepare Sources
      // const sources = relevantMatches.map((match) => ({
      //   id: match.id,
      //   score: match.score,
      //   title: match.metadata?.title || match.payload?.title || "Source",
      //   url: match.metadata?.url || match.payload?.url,
      //   type: match.metadata?.type || match.payload?.type || "unknown",
      //   domain: match.metadata?.domain || match.payload?.domain,
      // }));

      return {
        success: true,
        answer: finalAnswer,
        conversationId,
      };
    } catch (error) {
      console.error(
        `Error in getAnswer for ConvID ${conversationId}, User ${userId}:`,
        error
      );

      // Check for specific errors
      if (error.message === "INSUFFICIENT_CREDITS") {
        return {
          success: false,
          error: "Insufficient credits to process the request.",
          errorCode: "INSUFFICIENT_CREDITS",
        };
      }

      // Generic error response
      return {
        success: false,
        error: `An error occurred: ${error.message}`,
        conversationId,
      };
    }
  }
}

// Route Handler
async function handleQuestionAnswer(
  userId,
  question,
  conversationId,
  options = {}
) {
  try {
    if (!userId || !question || !conversationId) {
      return {
        success: false,
        error: "userId, question, and conversationId are required.",
      };
    }

    const qa = new QuestionAnsweringSystem();
    const result = await qa.getAnswer(
      userId,
      question,
      conversationId,
      options
    );
    return result;
  } catch (error) {
    console.error("Critical error in question handler:", error);
    return {
      success: false,
      error: "An unexpected server error occurred.",
    };
  }
}

module.exports = {
  QuestionAnsweringSystem,
  handleQuestionAnswer,
};
