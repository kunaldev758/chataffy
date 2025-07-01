require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const { OpenAI } = require("openai");
const ChatMessageController = require("../controllers/ChatMessageController");
// const Usage = require("../models/UsageSchema"); // Keep if still used elsewhere, remove if only for old tracking
const Client = require("../models/Client");
const Widget = require("../models/Widget");
const OpenAIUsageController = require("../controllers/OpenAIUsageController");
const UnifiedPricingService = require("../services/UnifiedPricingService"); // Import the new service

// --- Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
// Define models used in this service
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-3.5-turbo';
const PINECONE_TIER = process.env.PINECONE_TIER || 'standard';
const PINECONE_POD_TYPE = process.env.PINECONE_POD_TYPE || 's1';

// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY, maxRetries: 5 });


// Removed the old PricingCalculator class

class QuestionAnsweringSystem {
  constructor() {
    // Explicitly set the model in OpenAIEmbeddings
    this.embeddingModel = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
      modelName: EMBEDDING_MODEL, // Use the configured model
    });

    this.pineconeClient = pinecone; // Use the shared client

    // Initialize the new pricing service, passing relevant config
    this.pricingService = new UnifiedPricingService(PINECONE_TIER, PINECONE_POD_TYPE);

    this.maxHistoryMessages = 5;
  }


  async getChatHistory(conversationId) {
    try {
      // Limit the number of messages fetched if possible at the DB level
      const messages = await ChatMessageController.getRecentChatMessages(
        conversationId,
        this.maxHistoryMessages * 2 // Fetch a bit more to ensure we get enough user/ai pairs
      );
      // Return only the last N messages after fetching
      return messages.slice(-this.maxHistoryMessages);
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
    - If the context does not include the answer, politely say that you couldn’t find the information in the knowledge base. Do not guess or fabricate answers.
    - If a question is unrelated to ${organisation} or the provided context, gently inform the user that you can only answer questions about ${organisation}.
    - If information is missing, suggest visiting the official website or contacting support for further assistance.
    
    Response Format:
    - Use clear and concise language.
    - Format all responses using HTML for better readability (e.g., use <p>, <ul>, <strong>).
    
    Example behaviors:
    - Greeting: If the user says "Hi", respond with something like "<p>Hello! 👋 How can I assist you today regarding ${organisation}?</p>"
    
    Maintain a friendly, professional tone throughout.`;

    const userPrompt = `Context from knowledge base:\n---\n${context}\n---\n\nChat History:\n---\n${chatHistory}\n---\n\nBased on the provided context and chat history, answer the following question:\nQuestion: ${question}`;

    try {
      const response = await openai.chat.completions.create({
        model: CHAT_MODEL, // Use configured chat model
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.5, // Slightly lower temp for more factual answers based on context
        max_tokens: 400,  // Adjust as needed
      });

      const answer = response.choices[0]?.message?.content?.trim() || "I apologize, I encountered an issue generating a response.";
      const usage = response.usage; // { prompt_tokens, completion_tokens, total_tokens }

      return { answer, usage }; // Return both answer and token usage

    } catch (error) {
      console.error("Error generating answer with OpenAI:", error);
      // Provide a safe fallback answer
      return { answer: "I'm currently unable to generate a response due to a technical issue. Please try again later.", usage: null };
    }
  }

  // Simplified context extraction
  getRelevantContext(matches) {
    // Sort by score and take top N (already done by Pinecone query 'topK')
    // Filter by score threshold happens before this function now
     return matches
       // .filter(match => match.score >= scoreThreshold) // Apply threshold if not done before
       .map((match) => match.metadata?.text || match.metadata?.pageContent || '') // Extract text content safely
       .filter(text => text.length > 0) // Remove empty contexts
       .join("\n\n---\n\n"); // Separate contexts clearly
  }

  // getEmbedding method removed - using this.embeddingModel.embedQuery directly

  async getAnswer(userId, question, conversationId, options = {}) {
    const {
      topK = 5,           // Fetch more candidates initially
      scoreThreshold = 0.75, // Slightly higher threshold for relevance
      // includeSources = false, // Decide if source tracking is needed
    } = options;

    let usageDetails = {
        embeddingTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    };

    try {
      // 1. Get Chat History
      const chatSession = await this.getChatHistory(conversationId);
      const chatHistory = this.formatChatHistory(chatSession);

      // 2. Calculate Embedding Cost
      const embeddingTokens = this.pricingService.estimateTokens(question);
      usageDetails.embeddingTokens = embeddingTokens;
     // costs.embedding = this.pricingService.calculateEmbeddingCost(questionTokens, EMBEDDING_MODEL);

      // 3. Generate Question Embedding
      const questionEmbedding = await this.embeddingModel.embedQuery(question);
      if (!questionEmbedding) {
          throw new Error("Failed to generate question embedding.");
      }

      // 5. Query Pinecone
      const clientData = await Client.findOne({ userId }).lean(); // Use lean for performance
      const widgetData = await Widget.findOne({ userId }).lean(); // Use lean

      if (!clientData || !clientData.pineconeIndexName) {
        throw new Error(`Pinecone index not configured for user ${userId}`);
      }
      if (!widgetData) {
          throw new Error(`Widget data not found for user ${userId}`);
      }

      const pineconeIndexName = clientData.pineconeIndexName;
      const index = this.pineconeClient.index(pineconeIndexName);

      const queryResponse = await index.query({
        vector: questionEmbedding,
        topK: topK, // Retrieve top K candidates
        includeMetadata: true,
        // filter: { userId: userId } // IMPORTANT: Filter results by userId if metadata contains it
      });

      // Filter matches by score threshold *after* retrieving them
      const relevantMatches = queryResponse.matches.filter(
        (match) => match.score >= scoreThreshold
      );

      console.log(`Pinecone query for "${question.substring(0, 30)}..." found ${queryResponse.matches.length} matches, ${relevantMatches.length} relevant.`);

      let finalAnswer;
      let completionUsage = null;

      if (relevantMatches.length === 0) {
        // Default answer when no relevant context found
         finalAnswer = `I couldn't find specific information about "${question}" in the knowledge base. You might find helpful information on the ${widgetData.organisation || 'company'} website: ${widgetData.website || '(Website not provided)'}`;

      } else {
        // 6. Get Context and Generate Answer via LLM
        const context = this.getRelevantContext(relevantMatches);

        // Estimate combined input tokens for chat completion (more accurate if possible)
        const promptForLLM = `Context: ${context}\nHistory: ${chatHistory}\nQuestion: ${question}`;
        usageDetails.promptTokens = this.pricingService.estimateTokens(promptForLLM); // Estimate based on constructed prompt

        const { answer: generatedAnswer, usage: llmUsage } = await this.generateAnswer(
          question,
          context,
          chatHistory,
          widgetData.organisation || "the company"
        );
        finalAnswer = generatedAnswer;
        completionUsage = llmUsage; // Get actual usage from OpenAI response

        // 7. Calculate Chat Completion Cost (use actual tokens if available)
        if (completionUsage) {
            usageDetails.promptTokens = completionUsage.prompt_tokens;
            usageDetails.completionTokens = completionUsage.completion_tokens;
        } else {
            // Fallback to estimation if actual usage not available
            usageDetails.completionTokens = this.pricingService.estimateTokens(finalAnswer);
        }
      }

      // 8. Calculate Total Cost
      usageDetails.totalTokens = usageDetails.embeddingTokens + (usageDetails.promptTokens || 0) + (usageDetails.completionTokens || 0);

      console.log(`Usage for ConvID ${conversationId}: Q_Tokens=${usageDetails.embeddingTokens}, P_Tokens=${usageDetails.promptTokens}, C_Tokens=${usageDetails.completionTokens}`);

      // 9. Record Usage (using the total cost)
      // Assuming recordUsageOfChat mainly cares about the total cost impact on credits
      try {
         await OpenAIUsageController.recordUsage(userId,'chat' , {
          // costs.total,
          ...usageDetails,
            completionModel: CHAT_MODEL, // Primary model involved
            pineconeQueries: 1, // Number of queries made
         });
      } catch (usageError) {
          // Decide how to handle usage recording failure - log, maybe retry?
          // If it's due to insufficient credits, the controller should handle that.
          console.error(`Failed to record chat usage for user ${userId}: ${usageError.message}`);
           // If recording failure means credits weren't deducted, maybe throw to signal issue?
           if (usageError.message.includes("Insufficient Credits")) { // Check specific error
                throw new Error("INSUFFICIENT_CREDITS"); // Propagate credit error
           }
           // Otherwise, log and continue, as the answer was generated
      }

      // 10. Prepare Sources (if needed)
      // const sources = /* includeSources ? */ relevantMatches.map((match) => ({
      //   id: match.id, // Pinecone vector ID
      //   score: match.score,
      //   title: match.metadata?.title || 'Source',
      //   url: match.metadata?.url, // Include URL if available in metadata
      //   // Potentially include a snippet of the text:
      //   // textSnippet: (match.metadata?.text || '').substring(0, 100) + '...'
      // })) /* : [] */;

      return {
        success: true,
        answer: finalAnswer,
        // sources: sources, // Return relevant sources
        // costs: costs,
        usage: usageDetails, // Return token usage details
        conversationId,
      };

    } catch (error) {
      console.error(`Error in getAnswer for ConvID ${conversationId}, User ${userId}:`, error);
      // Check for specific errors like insufficient credits propagated from usage recording
       if (error.message === "INSUFFICIENT_CREDITS") {
          return {
              success: false,
              error: "Insufficient credits to process the request.",
              errorCode: "INSUFFICIENT_CREDITS", // Add specific code
              // costs: costs, // Return costs calculated so far
              usage: usageDetails,
          };
       }
      // Generic error response
      return {
        success: false,
        error: `An error occurred: ${error.message}`,
        // costs: costs, // Return costs calculated so far
        usage: usageDetails,
      };
    }
  }
}

// Route Handler remains mostly the same, just calls the updated class
async function handleQuestionAnswer(userId, question, conversationId, options = {}) {
  try {
    if (!userId || !question || !conversationId) {
      // Return a structured error instead of throwing raw Error
      return { success: false, error: "userId, question, and conversationId are required." };
    }

    const qa = new QuestionAnsweringSystem(); // Creates instance with new pricing service
    const result = await qa.getAnswer(userId, question, conversationId, options);
    return result; // Return the result object (contains success/error)

  } catch (error) {
    // Catch unexpected errors during instantiation or setup
    console.error("Critical error in question handler:", error);
    return {
        success: false,
        error: "An unexpected server error occurred.",
    };
  }
}

module.exports = {
  QuestionAnsweringSystem, // Export class if needed elsewhere
  handleQuestionAnswer,
};