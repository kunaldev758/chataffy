const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const OpenAI = require("openai");
const mongoose = require("mongoose");

// MongoDB Schema for Chat History
const ChatSessionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  messages: [
    {
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now },
});

// Add Usage Schema for cost tracking
const UsageSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  operation: { type: String, required: true }, // 'embedding', 'pinecone_query', 'chat_completion'
  details: {
    inputTokens: Number,
    outputTokens: Number,
    vectorCount: Number,
    cost: Number,
  },
});

const Usage = mongoose.model("Usage", UsageSchema);

const ChatSession = mongoose.model("ChatSession", ChatSessionSchema);

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

  async getChatHistory(userId) {
    try {
      let session = await ChatSession.findOne({ userId });

      if (!session) {
        session = new ChatSession({ userId, messages: [] });
        await session.save();
      }

      return session;
    } catch (error) {
      console.error("Error getting chat history:", error);
      throw error;
    }
  }

  async addMessageToHistory(userId, role, content) {
    try {
      const session = await ChatSession.findOne({ userId });

      if (session) {
        session.messages.push({ role, content });
        session.lastUpdated = new Date();
        await session.save();
      }
    } catch (error) {
      console.error("Error adding message to history:", error);
      throw error;
    }
  }

  formatChatHistory(messages) {
    // Get last few messages
    const recentMessages = messages.slice(-this.maxHistoryMessages);
    return recentMessages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");
  }

  async generateAnswer(question, context, chatHistory) {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are a helpful chat agent for seoant. 
                - Always be professional, friendly, and helpful
                - Focus on providing information about seoant 
                - If a question is outside your knowledge, politely redirect or suggest visiting the website
                - Use a conversational but professional tone
                - Represent the brand's values and mission`,
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

  async getAnswer(userId, question, options = {}) {
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
      const chatSession = await this.getChatHistory(userId);
      const chatHistory = this.formatChatHistory(chatSession.messages);

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
      const index = this.pinecone.index(process.env.PINECONE_INDEX_NAME);
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
        (answer =
          //   "I couldn't find any relevant information in my knowledge base to answer your question.";
          `I apologize, but I couldn't find specific information about "${question}" in our knowledge base. 
            For the most accurate and up-to-date information, I recommend visiting our website 
            or checking our contact page .`),
          `Thank you for your question. While I couldn't locate exact details about "${question}", 
            I'd be happy to help you find more information. Please consider visiting our website 
            or reaching out to our support team.`,
          `I appreciate your inquiry about "${question}". However, this specific detail isn't 
            currently in my knowledge base. For comprehensive information, please visit 
            our website or contact our support team.`;
      } else {
        // Get context and generate answer
        const context = await this.getRelevantContext(relevantMatches);
        answer = await this.generateAnswer(question, context, chatHistory);

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

      // Save the interaction to history
      await this.addMessageToHistory(userId, "user", question);
      await this.addMessageToHistory(userId, "assistant", answer);

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
        conversationId: chatSession._id,
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
async function handleQuestionAnswer(req, res) {
  try {
    const { userId, question, options } = req.body;

    if (!userId || !question) {
      return res.status(400).json({
        success: false,
        error: "userId and question are required",
      });
    }

    const qa = new QuestionAnsweringSystem();
    const result = await qa.getAnswer(userId, question, options);
    res.json(result);
  } catch (error) {
    console.error("Error in question handler:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}

module.exports = {
  QuestionAnsweringSystem,
  handleQuestionAnswer,
  ChatSession,
};
