require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { OpenAI } = require("openai");
const ChatMessageController = require("../controllers/ChatMessageController");
const Client = require("../models/Client");
const Widget = require("../models/Widget");

const { logOpenAIUsage } = require("../services/UsageTrackingService");

// --- Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Define models used in this service
const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1";

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

  // Detect if the question is a simple greeting or requires no context
  isSimpleGreeting(question) {
    const normalizedQuestion = question.toLowerCase().trim();
    const greetings = [
      "hi",
      "hello",
      "hey",
      "greetings",
      "good morning",
      "good afternoon",
      "good evening",
      "good night",
      "howdy",
      "sup",
      "what's up",
      "hey there",
    ];
    return greetings.some(
      (greeting) =>
        normalizedQuestion === greeting ||
        normalizedQuestion.startsWith(greeting + " ") ||
        normalizedQuestion === greeting + "!"
    );
  }

  async generateAnswer(
    question,
    context,
    chatHistory,
    organisation,
    fallbackMessage,
    email
  ) {
  
    const systemPrompt = `You are a professional, friendly, and helpful chat agent for ${organisation}. 

Behavior Guidelines:
- Maintain a warm, approachable, and professional tone.
- Respond naturally — **do not greet in every reply**. Only greet once at the very start of a new chat or if the user greets first and no greeting has been exchanged yet.

- **IMPORTANT**: Use the provided context to answer questions. If the context contains relevant information, use it to provide a helpful answer.
- If the answer is not found in the context, say that ${fallbackMessage}.
- If a question is unrelated to ${organisation}, respond that you can only answer queries related to ${organisation}.
- For general questions about the company (like "who are you?", "what products do you have?", "contact details"), try to extract relevant information from the context even if it's not a perfect match.

Response Format:
- Use clean, readable **HTML**.
- Keep responses concise and clear.
- Prefer **bullet points (<ul><li>…</li></ul>)** for multiple facts or items.
- Highlight important terms with **<strong>…</strong>**.
- Format links so they are visually distinct, e.g.:
  <a href="https://example.com" target="_blank" style="color:#007bff; text-decoration:underline;">Visit here</a>
- Avoid unnecessary repetition or greetings in consecutive messages.

Example behaviors:
- First greeting in a new chat: "<p>Hello! 👋 How can I assist you today regarding ${organisation}?</p>"
- Follow-up answers: "<p>Here's the information you asked for:</p><ul>…</ul>"

General Notes:
- Always try to provide a complete response — don't cut off mid-sentence. 
- Never fabricate links — only use those provided in context.
- If context is provided, make an effort to extract and present relevant information even if it's not a perfect match to the question.
`;

    // const userPrompt = `Context from knowledge base:\n---\n${context}\n---\n\nChat History:\n---\n${chatHistory}\n---\n\nBased on the provided context and chat history, answer the following question:\nQuestion: ${question}`;

    const userPrompt = `Context from knowledge base:
---
${context}
---

Chat History:
---
${chatHistory}
---

Based on the provided context and chat history, answer the following user question in HTML format:
Question: ${question}

Important:
- If the answer is long, summarize key points first, then mention where to find full details.
- Provide a natural, complete response without abrupt cutoffs.`;

    try {
      const response = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 1000,
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
        `[QueryController] Querying Qdrant collection: ${collectionName} with topK: ${topK}, userId: ${userId}`
      );

      // Check if collection exists and get stats
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections.some(
        (col) => col.name === collectionName
      );

      if (!collectionExists) {
        console.error(
          `[QueryController] ERROR: Qdrant collection "${collectionName}" does not exist`
        );
        return [];
      }

      // Get collection info to check point count
      try {
        const collectionInfo = await this.qdrantClient.getCollection(
          collectionName
        );
        const pointCount = collectionInfo.points_count || 0;
        console.log(
          `[QueryController] Collection "${collectionName}" has ${pointCount} total points`
        );

        if (pointCount === 0) {
          console.warn(
            `[QueryController] WARNING: Collection is empty! No data has been indexed.`
          );
          return [];
        }
      } catch (infoError) {
        console.warn(
          `[QueryController] Could not get collection info: ${infoError.message}`
        );
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

      // First try with user_id filter
      let searchResult = [];
      if (userId) {
        try {
          searchResult = await this.qdrantClient.search(collectionName, {
            vector: queryEmbedding,
            limit: topK,
            with_payload: true,
            filter: {
              must: [
                {
                  key: "user_id",
                  match: { value: userId.toString() },
                },
              ],
            },
          });
          console.log(
            `[QueryController] Query with user_id filter returned ${searchResult.length} results`
          );
        } catch (filterError) {
          console.warn(
            `[QueryController] Error with user_id filter: ${filterError.message}`
          );
        }
      }

      // If no results with filter, try without filter (fallback for debugging)
      if (searchResult.length === 0 && userId) {
        console.warn(
          `[QueryController] No results with user_id filter. Trying without filter to check if data exists...`
        );
        try {
          const unfilteredResult = await this.qdrantClient.search(
            collectionName,
            {
              vector: queryEmbedding,
              limit: Math.min(topK * 2, 20), // Get more results to see what's there
              with_payload: true,
            }
          );
          console.log(
            `[QueryController] Query WITHOUT filter returned ${unfilteredResult.length} results. ` +
              `Sample user_ids found: ${unfilteredResult
                .slice(0, 3)
                .map((r) => r.payload?.user_id)
                .filter(Boolean)
                .join(", ")}`
          );

          // If we found results without filter, it means user_id mismatch
          if (unfilteredResult.length > 0) {
            console.error(
              `[QueryController] CRITICAL: Data exists but user_id filter is excluding all results! ` +
                `Expected user_id: ${userId}, Found user_ids: ${[
                  ...new Set(
                    unfilteredResult
                      .map((r) => r.payload?.user_id)
                      .filter(Boolean)
                  ),
                ].join(", ")}`
            );
          }
        } catch (unfilteredError) {
          console.error(
            `[QueryController] Error querying without filter: ${unfilteredError.message}`
          );
        }
      } else if (!userId) {
        // No userId provided, query without filter
        searchResult = await this.qdrantClient.search(collectionName, {
          vector: queryEmbedding,
          limit: topK,
          with_payload: true,
        });
        console.log(
          `[QueryController] Query without user_id filter returned ${searchResult.length} results`
        );
      }

      return searchResult.map((result) => ({
        id: result.id,
        score: result.score,
        metadata: result.payload || {},
        payload: result.payload || {}, // Keep original payload for compatibility
      }));
    } catch (error) {
      console.error("[QueryController] Error querying Qdrant:", error);

      // If it's a collection not found error, return empty results
      if (error.message && error.message.includes("not found")) {
        console.error(
          `[QueryController] Collection ${collectionName} not found in Qdrant`
        );
        return [];
      }

      throw new Error(`Qdrant query failed: ${error.message}`);
    }
  }

  async getAnswer(userId, question, conversationId, options = {}) {
    // Default threshold: 0.4 is reasonable for cosine similarity
    // Lower thresholds (0.2-0.3) may include irrelevant results
    // Higher thresholds (0.5-0.7) may be too strict and miss relevant results
    const { topK = 5, scoreThreshold = 0.4 } = options;

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

      if (
        !clientData ||
        !clientData.qdrantIndexName ||
        !clientData.qdrantIndexNamePaid
      ) {
        throw new Error(`Qdrant collection not configured for user ${userId}`);
      }
      if (!widgetData) {
        throw new Error(`Widget data not found for user ${userId}`);
      }

      // Use the same field name for compatibility, but it represents Qdrant collection now

      const collectionName =
        clientData?.plan == "free"
          ? clientData?.qdrantIndexName
          : clientData?.qdrantIndexNamePaid;

      // 5. Query Qdrant
      // Convert userId to string to ensure proper matching in Qdrant filter
      const userIdString = userId?.toString();
      const queryResponse = await this.queryQdrant(
        collectionName,
        questionEmbedding,
        topK,
        userIdString
      );

      // Log if no results found at all
      if (queryResponse.length === 0) {
        console.warn(
          `[QueryController] WARNING: No results found in collection "${collectionName}" for user "${userIdString}". This could mean:\n` +
            `  1. Collection is empty or has no data for this user\n` +
            `  2. Data hasn't been indexed yet\n` +
            `  3. Collection name is incorrect\n` +
            `  4. user_id filter is too restrictive`
        );
      }

      // Get threshold from widget settings or use default/options
      const widgetThreshold = widgetData?.scoreThreshold;
      let effectiveThreshold =
        widgetThreshold !== undefined ? widgetThreshold : scoreThreshold;

      // Warn if threshold is very low (may include irrelevant results)
      if (effectiveThreshold < 0.3) {
        console.warn(
          `[QueryController] Low score threshold (${effectiveThreshold}) may include irrelevant results. Consider using 0.4-0.5 for better quality.`
        );
      }

      // Filter matches by score threshold
      let relevantMatches = queryResponse.filter(
        (match) => match.score >= effectiveThreshold
      );

      // If no matches found with current threshold, try with a lower threshold as fallback
      if (relevantMatches.length === 0 && queryResponse.length > 0) {
        const fallbackThreshold = Math.max(0.2, effectiveThreshold - 0.15); // Lower by 0.15 but not below 0.2
        console.warn(
          `[QueryController] No matches above threshold ${effectiveThreshold}. Trying fallback threshold ${fallbackThreshold.toFixed(
            2
          )}...`
        );
        const fallbackMatches = queryResponse.filter(
          (match) => match.score >= fallbackThreshold
        );
        if (fallbackMatches.length > 0) {
          relevantMatches = fallbackMatches;
          effectiveThreshold = fallbackThreshold;
          console.log(
            `[QueryController] Fallback threshold found ${fallbackMatches.length} matches. Using these results.`
          );
        }
      }

      // Enhanced logging for threshold tuning
      const scoreStats =
        queryResponse.length > 0
          ? {
              min: Math.min(...queryResponse.map((m) => m.score)),
              max: Math.max(...queryResponse.map((m) => m.score)),
              avg:
                queryResponse.reduce((sum, m) => sum + m.score, 0) /
                queryResponse.length,
              scores: queryResponse.map((m) => m.score.toFixed(3)),
            }
          : null;

      console.log(
        `[QueryController] Query: "${question.substring(
          0,
          50
        )}..." | Collection: ${collectionName} | Found: ${
          queryResponse.length
        } matches, ${
          relevantMatches.length
        } relevant (threshold: ${effectiveThreshold})`
      );
      if (scoreStats) {
        console.log(
          `[QueryController] Score stats - Min: ${scoreStats.min.toFixed(
            3
          )}, Max: ${scoreStats.max.toFixed(3)}, Avg: ${scoreStats.avg.toFixed(
            3
          )} | Scores: [${scoreStats.scores.slice(0, 5).join(", ")}${
            scoreStats.scores.length > 5 ? "..." : ""
          }]`
        );
      }
      if (queryResponse.length > 0 && relevantMatches.length === 0) {
        console.warn(
          `[QueryController] WARNING: Found ${queryResponse.length} matches but ALL were below threshold ${effectiveThreshold}. Consider lowering threshold or checking data quality.`
        );
      }

      let finalAnswer;
      // let completionUsage = null;

      // Handle simple greetings even without context
      if (relevantMatches.length === 0 && this.isSimpleGreeting(question)) {
        // For greetings, generate a friendly response even without context
        const { answer: greetingAnswer, usage: llmUsage } =
          await this.generateAnswer(
            question,
            `This is a greeting. The user said: "${question}". Respond warmly and ask how you can help regarding ${
              widgetData.organisation || "the company"
            }.`,
            chatHistory,
            widgetData.organisation || "the company",
            widgetData.fallbackMessage ||
              "I couldn't find specific information about your question in the knowledge base. You might contact support",
            widgetData.email || "support@example.com"
          );
        finalAnswer = greetingAnswer;
        if (llmUsage) {
          logOpenAIUsage({
            userId,
            tokens: llmUsage.total_tokens,
            requests: 1,
          });
        }
      } else if (relevantMatches.length === 0) {
        // Default answer when no relevant context found (and not a greeting)
        finalAnswer =
          widgetData.fallbackMessage ||
          `I couldn't find specific information about your question in the knowledge base. You might contact support on ${
            widgetData.email || "support@example.com"
          }`;
      } else {
        // 6. Get Context and Generate Answer via LLM
        const context = this.getRelevantContext(relevantMatches);

        const { answer: generatedAnswer, usage: llmUsage } =
          await this.generateAnswer(
            question,
            context,
            chatHistory,
            widgetData.organisation || "the company",
            widgetData.fallbackMessage ||
              "I couldn't find specific information about your question in the knowledge base. You might contact support",
            widgetData.email || "support@example.com"
          );
        finalAnswer = generatedAnswer;
        logOpenAIUsage({ userId, tokens: llmUsage.total_tokens, requests: 1 });
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
