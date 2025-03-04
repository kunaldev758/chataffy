require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const OpenAI = require("openai");
const ChatMessageController = require("../controllers/ChatMessageController");
const Usage = require("../models/UsageSchema");
const Client = require("../models/Client");
const Widget = require("../models/Widget");
const OpenAIUsageController = require("../controllers/OpenAIUsageController");

class PricingCalculator {
  constructor() {
    // Current pricing rates (as of 2024)
    this.rates = {
      embedding: {
        ada: 0.0001, // per 1K tokens
      },
      chatCompletion: {
        "gpt-3.5-turbo": {
          input: 0.001, // per 1K tokens
          output: 0.002, // per 1K tokens
        },
      },
      pinecone: {
        query: 0.0002, // per query
        vector: 0.0002, // per vector per month
      },
    };
  }

  async estimateTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  calculateEmbeddingCost(tokens) {
    return (tokens / 1000) * this.rates.embedding.ada;
  }

  calculateChatCompletionCost(
    inputTokens,
    outputTokens,
    model = "gpt-3.5-turbo"
  ) {
    const inputCost =
      (inputTokens / 1000) * this.rates.chatCompletion[model].input;
    const outputCost =
      (outputTokens / 1000) * this.rates.chatCompletion[model].output;
    return inputCost + outputCost;
  }

  calculatePineconeQueryCost(queryCount) {
    return queryCount * this.rates.pinecone.query;
  }
}

class QuestionAnsweringSystem {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.embeddingModel = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });

    this.pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      maxRetries: 5,
    });

    // Maximum number of previous messages to include in context
    this.pricingCalculator = new PricingCalculator();
    this.maxHistoryMessages = 5;
  }

  async trackUsage(userId, operation, details) {
    const usage = new Usage({
      userId,
      operation,
      details,
    });
    await usage.save();
  }

  // Add method to get usage summary
  async getUserUsageSummary(userId, startDate, endDate) {
    const usage = await Usage.aggregate([
      {
        $match: {
          userId,
          timestamp: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$operation",
          totalCost: { $sum: "$details.cost" },
          count: { $sum: 1 },
        },
      },
    ]);

    return {
      summary: usage,
      totalCost: usage.reduce((sum, item) => sum + item.totalCost, 0),
    };
  }

  async getChatHistory(conversationId) {
    try {
      const session = await ChatMessageController.getRecentChatMessages(
        conversationId
      );
      return session;
    } catch (error) {
      console.error("Error getting chat history:", error);
      throw error;
    }
  }

  formatChatHistory(messages) {
    // Get last few messages
    const recentMessages = messages.slice(-this.maxHistoryMessages);
    return recentMessages
      .map((msg) => `${msg.sender_type}: ${msg.message}`)
      .join("\n");
  }

  async generateAnswer(question, context, chatHistory,organisation) {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are a helpful chat agent for ${organisation}. 
                - Always be professional, friendly, and helpful
                - Focus on providing information about ${organisation} 
                - If a question is outside your knowledge, politely redirect or suggest visiting the website
                - Use a conversational but professional ton
                - Represent the brand's values and mission
                - Format responses using proper HTML for display:
                      - Use <h2> for headings.
                      - Use <strong> for important words.
                      - Use <p> for paragraphs.
                      - Use <ul> and <li> for lists where applicable.`,
          },
          {
            role: "user",
            content: `Context from knowledge base: ${context}\n\nChat History:\n${chatHistory}\n\nCurrent Question: ${question}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error("Error generating answer:", error);
      throw error;
    }
  }

  async getRelevantContext(matches) {
    const sortedMatches = matches.sort((a, b) => b.score - a.score);
    return sortedMatches.map((match) => match.metadata.text).join("\n\n");
  }

  async getAnswer(userId, question, conversationId, options = {}) {
    try {
      const {
        topK = 3,
        scoreThreshold = 0.7,
        includeSources = false,
      } = options;

      let costs = {
        embedding: 0,
        pineconeQuery: 0,
        chatCompletion: 0,
        total: 0,
      };

      // Get chat history
      const chatSession = await this.getChatHistory(conversationId);
      const chatHistory = this.formatChatHistory(chatSession);

      // Calculate and track embedding cost
      const questionTokens = await this.pricingCalculator.estimateTokens(
        question
      );
      const embeddingCost =
        this.pricingCalculator.calculateEmbeddingCost(questionTokens);
      costs.embedding = embeddingCost;

      await this.trackUsage(userId, "embedding", {
        inputTokens: questionTokens,
        cost: embeddingCost,
      });

      // Generate embedding for the question
      const questionEmbedding = await this.embeddingModel.embedQuery(question);

      // Calculate and track Pinecone query cost
      const pineconeQueryCost =
        this.pricingCalculator.calculatePineconeQueryCost(1);
      costs.pineconeQuery = pineconeQueryCost;

      await this.trackUsage(userId, "pinecone_query", {
        vectorCount: 1,
        cost: pineconeQueryCost,
      });

      // Query Pinecone
      // const pineconeneIndexName = await Client.findOne({ userId: userId });
      const client = await Client.findOne({ userId });
      const widget = await Widget.findOne({ userId });
      const pineconeIndexName = client.pineconeIndexName;

      const index = this.pinecone.index(pineconeIndexName);
      const queryResponse = await index.query({
        vector: questionEmbedding,
        topK,
        includeMetadata: true,
      });

      const relevantMatches = queryResponse.matches.filter(
        (match) => match.score >= scoreThreshold
      );

      let answer;
      if (relevantMatches.length === 0) {
        (answer = `I apologize, but I couldn't find specific information about "${question}" in our knowledge base. 
            For the most accurate and up-to-date information, I recommend visiting our website: ${widget.website} 
            or checking our contact page .`),
          `Thank you for your question. While I couldn't locate exact details about "${question}", 
            I'd be happy to help you find more information. Please consider visiting our website : ${widget.website}
            or reaching out to our support team.`,
          `I appreciate your inquiry about "${question}". However, this specific detail isn't 
            currently in my knowledge base. For comprehensive information, please visit 
            our website or contact our support team.`;
      } else {
        // Get context and generate answer
        const context = await this.getRelevantContext(relevantMatches);
        answer = await this.generateAnswer(
          question,
          context,
          chatHistory,
          widget.organisation
        );

        // Calculate and track chat completion cost
        const inputTokens = await this.pricingCalculator.estimateTokens(
          question + context + chatHistory
        );
        const outputTokens = await this.pricingCalculator.estimateTokens(
          answer
        );
        const completionCost =
          this.pricingCalculator.calculateChatCompletionCost(
            inputTokens,
            outputTokens
          );
        costs.chatCompletion = completionCost;

        await this.trackUsage(userId, "chat_completion", {
          inputTokens,
          outputTokens,
          cost: completionCost,
        });
      }

      // Calculate total cost
      costs.total =
        costs.embedding + costs.pineconeQuery + costs.chatCompletion;
      try {
        OpenAIUsageController.recordUsageOfChat(userId, costs.total);
      } catch (error) {
        throw new Error("Not Enough Credits");
      }

      // Prepare sources if requested
      const sources = includeSources
        ? relevantMatches.map((match) => ({
            url: match.metadata.url,
            score: match.score,
          }))
        : [];

      return {
        success: true,
        answer,
        sources,
        costs,
        conversationId,
      };
    } catch (error) {
      console.error("Error in getAnswer:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

// Express route handler
async function handleQuestionAnswer(userId, question, conversationId, options) {
  try {
    if (!userId || !question || !conversationId) {
      throw new Error("userId and question and conversationId are required");
    }

    const qa = new QuestionAnsweringSystem();
    const result = await qa.getAnswer(
      userId,
      question,
      conversationId,
      (options = {})
    );
    return result;
  } catch (error) {
    console.error("Error in question handler:", error);
    throw error;
  }
}

module.exports = {
  QuestionAnsweringSystem,
  handleQuestionAnswer,
};
