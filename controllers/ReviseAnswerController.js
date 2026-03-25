require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { v4: uuidv4 } = require("uuid");
const Agent = require("../models/Agent");
const Client = require("../models/Client");
const { logOpenAIUsage, logQdrantUsage } = require("../services/UsageTrackingService");

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIMENSION = parseInt(process.env.OPENAI_EMBEDDING_DIMENSION || "1536", 10);

const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const embeddings = new OpenAIEmbeddings({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: EMBEDDING_MODEL,
});

/**
 * POST /revise-answer
 * Stores a human-corrected Q&A pair as a vector in Qdrant so future similar
 * visitor questions will match the expected (correct) response.
 *
 * Body: { visitorMessage, agentResponse, expectedResponse, agentId, userId }
 */
const reviseAnswer = async (req, res) => {
  try {
    const { visitorMessage, agentResponse, expectedResponse, agentId, userId } = req.body;

    if (!visitorMessage || !expectedResponse || !agentId || !userId) {
      return res.status(400).json({
        success: false,
        error: "visitorMessage, expectedResponse, agentId and userId are required.",
      });
    }

    const client = await Client.findOne({ userId });
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found." });
    }

    // Derive Qdrant collection name (same convention as scraping/query)
    const agent = await Agent.findById(agentId).lean();
    if (!agent) {
      return res.status(404).json({ success: false, error: "Agent not found." });
    }

    const collectionName = client?.plan == "free"
      ? agent?.qdrantIndexName
      : agent?.qdrantIndexNamePaid;

    // The text we embed is the visitor question, so future semantic matches surface
    // this revised answer when someone asks something similar.
    const textToEmbed = visitorMessage.trim();

    // The stored text (what will be used as context) is the expected response
    const storedText = expectedResponse.trim();

    // Generate embedding
    const [vector] = await embeddings.embedDocuments([textToEmbed]);

    const tokens = Math.ceil(textToEmbed.length / 4);
    if (tokens > 0) {
      logOpenAIUsage({ userId, agentId, tokens, requests: 1 });
    }

    const point = {
      id: uuidv4(),
      vector,
      payload: {
        text: storedText,
        source_type: "revised_answer",
        type: 4, // 4 = revised answer (0=WebPage,1=File,2=Snippet,3=FAQ)
        title: "Revised Answer",
        original_question: visitorMessage,
        original_ai_response: agentResponse || "",
        user_id: userId.toString(),
        agent_id: agentId.toString(),
        created_at: new Date().toISOString(),
      },
    };

    await qdrantClient.upsert(collectionName, { points: [point], wait: true });

    // Log Qdrant usage
    const storageMB = (EMBEDDING_DIMENSION * 4) / (1024 * 1024);
    await logQdrantUsage({
      userId,
      vectorsAdded: 1,
      vectorsDeleted: 0,
      storageMB,
      collectionName,
      estimatedCost: { storage: (storageMB / 1024) * 0.12, requests: 0.0001 },
    });

    console.log(`[ReviseAnswer] Stored revised answer vector for user ${userId}, agent ${agentId}`);

    return res.status(200).json({
      success: true,
      message: "Revised answer stored successfully. Future similar questions will use this response.",
    });
  } catch (error) {
    console.error("[ReviseAnswer] Error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error." });
  }
};

module.exports = { reviseAnswer };
