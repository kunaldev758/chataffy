require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { OpenAI } = require("openai");
const ChatMessageController = require("../controllers/ChatMessageController");
const ChatMessage = require("../models/ChatMessage");
const Client = require("../models/Client");
const Widget = require("../models/Widget");
const Agent = require("../models/Agent");
const WebsiteData = require("../models/WebsiteData");
const HumanAgent = require("../models/HumanAgent");
const { logOpenAIUsage, computeTokenCosts } = require("../services/UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("../services/aiModelService");
const {
  routeQuery,
  ROUTES,
  isLiveAgentRequest,
  isPureGreeting,
  detectSoftOffer,
  isCategoryNavigationRequest,
} = require("../services/QueryRouter");
const {
  buildAcknowledgementResponse,
  isGibberishOrAccidentalMessage,
} = require("../services/LightweightResponseService");
const { generateContactResponse } = require("../services/LlamaContactService");
const {
  generateGreeting,
  generateAccidentalReply,
  generateLiveAgentReply,
  generateOffTopicReply,
} = require("../services/LlamaGreetingService");
const {
  expandQueryForRetrieval,
  isProductLinkRequest,
} = require("../utils/queryContextExpansion");
const {
  normalizeUserQuery,
  buildRetrievalKeywords,
} = require("../utils/queryNormalization");
const {
  extractQueryAttributes,
  needsKeywordRetrieval,
} = require("../utils/queryAttributes");
const {
  buildRetrievalPlan,
  selectMatchesByPlan,
  logRetrievalPlan,
} = require("../services/retrievalPlan");
const {
  prepareRetrievalQuery,
} = require("../services/retrieval/prepareRetrievalQuery");
const {
  enrichRoutingMultiEntity,
  resolveEntities,
} = require("../services/retrieval/entityResolution");
const {
  buildMultiEntityRetrievalPlan,
} = require("../services/retrieval/entityPlanBuilder");
const { MULTI_ENTITY_MODES } = require("../services/retrieval/multiEntityModes");
const {
  runMultiEntityRetrieval,
} = require("../services/retrieval/multiEntityRetrieval");
const {
  rerankByAttributes,
  logRerankStats,
  filterMatchesBySizes,
} = require("../utils/attributeReranker");
const QdrantVectorStoreManager = require("../services/QdrantService");
const {
  isClearlyOnTopicCompanyQuestion: detectClearlyOnTopicQuestion,
  isCompanyIdentityQuestion: detectCompanyIdentityQuestion,
  isTrulyOffTopicQuestion,
} = require("../utils/queryOnTopicDetection");
const {
  buildSystemPrompt,
  buildFallbackPrompt,
  buildAnswerInstructions,
  appendReplyLanguage,
} = require("../services/SystemPromptBuilder");
const {
  isContactIntentQuestion,
  isPrimarilyContactQuestion: detectPrimarilyContactQuestion,
} = require("../utils/contactIntentDetection");
const {
  loadRagState,
  saveRagState,
  clearRagState,
  topicsFromRagState,
  buildUpdatedRagState,
  buildAckRagState,
  shouldClearRagState,
  shouldClearEntitiesOnly,
  AWAITING_FOLLOW_UP,
} = require("../services/conversationStateService");
const Conversation = require("../models/Conversation");

// --- Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Define models used in this service
const DEFAULT_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const CHAT_MODEL_PREMIUM =
  process.env.OPENAI_CHAT_MODEL_PREMIUM ||
  process.env.OPENAI_CHAT_MODEL ||
  "gpt-4.1";
const CHAT_MODEL_BRIEF = process.env.OPENAI_CHAT_MODEL_BRIEF || "gpt-4.1-mini";
const CHAT_HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT) || 5;
const CHAT_HISTORY_LIMIT_BRIEF =
  Number(process.env.CHAT_HISTORY_LIMIT_BRIEF) || 5;
const RAG_MAX_CHUNK_CHARS = Number(process.env.RAG_MAX_CHUNK_CHARS) || 1200;
const RAG_MAX_CHUNK_CHARS_BRIEF =
  Number(process.env.RAG_MAX_CHUNK_CHARS_BRIEF) || 6000;
const RAG_MAX_CONTEXT_CHARS = Number(process.env.RAG_MAX_CONTEXT_CHARS) || 6000;
const RAG_MAX_CONTEXT_CHARS_BRIEF =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
const RAG_MAX_CONTEXT_CHARS_LIST =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_LIST) || 3000;
const RAG_MAX_CONTEXT_CHARS_LINKS =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_LINKS) || 3000;
const RAG_MAX_CHUNK_CHARS_LIST =
  Number(process.env.RAG_MAX_CHUNK_CHARS_LIST) || 800;
const RAG_LIST_MAX_URLS = Number(process.env.RAG_LIST_MAX_URLS) || 30;
const RAG_KEYWORD_FETCH_MAX = Number(process.env.RAG_KEYWORD_FETCH_MAX) || 120;
/** Max unique sources shown in UI — taken from chunks used for answer generation. */
const MAX_ANSWER_SOURCES = Number(process.env.MAX_ANSWER_SOURCES) || 6;
const USE_LIGHTWEIGHT_RESPONSES =
  process.env.USE_LIGHTWEIGHT_RESPONSES !== "false";
const LOW_RETRIEVAL_SCORE_PREMIUM =
  Number(process.env.LOW_RETRIEVAL_SCORE_PREMIUM) || 0.35;

function stripHtmlForContext(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true when a chunk is low-value boilerplate that should be excluded
 * from page-merge context (footers, nav, cookie banners, etc.).
 */
function isBoilerplateChunk(text) {
  if (!text || text.length < 30) return true;
  const t = text.toLowerCase();

  // Footer label injected at training time by jobService
  if (t.includes("footer links (from")) return true;

  // Common footer/nav boilerplate phrases
  if (t.includes("got some questions?") && t.includes("here for you"))
    return true;
  if (
    t.includes("privacy policy") &&
    t.includes("terms and conditions") &&
    text.length < 400
  )
    return true;
  if (t.includes("best price guaranteed") && t.includes("our website"))
    return true;

  // Cookie / newsletter banners
  if (t.includes("we use cookies") || t.includes("subscribe to our newsletter"))
    return true;

  // Link-heavy chunks (≥4 URLs, few real words) — but never discard a chunk
  // that contains actual product/pricing data.  Product cards on e-commerce
  // pages frequently have 4+ URLs (image CDN, product page, cart button,
  // heading link) alongside a real price like "Now: $3,195.00".  Throwing
  // those away means the AI never sees the price even though it is in Qdrant.
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  const wordCount = text.trim().split(/\s+/).length;
  if (linkCount >= 4 && wordCount < 25) {
    // Keep the chunk if it carries any product/price signal
    const hasPriceSignal =
      /\$[\d,]+|\b(msrp|price|now|was|sale|cost|discount|off)\b/i.test(text);
    if (!hasPriceSignal) return true;
  }

  // Heading-only chunks — single # line, no body text
  const trimmed = text.trim();
  if (
    /^#{1,4}\s+\S/.test(trimmed) &&
    trimmed.split("\n").length <= 2 &&
    trimmed.length < 100
  )
    return true;

  return false;
}

function keywordFetchLimit(requestedCount, perItemMultiplier, floor) {
  const raw = Math.max(
    floor,
    (Number(requestedCount) || 5) * perItemMultiplier,
  );
  return Math.min(raw, RAG_KEYWORD_FETCH_MAX);
}

function hasProductSignals(text) {
  return /\b(price|cost|\$|£|€|usd|sale|add to cart|in stock)\b/i.test(text);
}

function pickBestChunkForUrl(chunks) {
  if (!chunks?.length) return { text: "", score: 0 };
  if (chunks.length === 1) return chunks[0];

  return chunks.reduce((best, cur) => {
    const curScore = cur.score ?? 0;
    const bestScore = best.score ?? 0;
    if (curScore !== bestScore) return curScore > bestScore ? cur : best;

    const curProduct = hasProductSignals(cur.text) ? 1 : 0;
    const bestProduct = hasProductSignals(best.text) ? 1 : 0;
    if (curProduct !== bestProduct)
      return curProduct > bestProduct ? cur : best;

    return cur.text.length > best.text.length ? cur : best;
  });
}

/** GPT-5 / o-series chat models reject `max_tokens`; they require `max_completion_tokens`. */
function chatCompletionLimitPayload(maxTokens, model) {
  if (/^gpt-5|^o\d/i.test(model || "")) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

function isPremiumResponseMode(responseMode) {
  return (
    responseMode === "list" ||
    responseMode === "contact" ||
    responseMode === "page_links" ||
    responseMode === "compare" ||
    responseMode === "recommend"
  );
}

function selectChatModel({
  responseMode = "brief",
  retrievalMaxScore,
  wasExpanded = false,
  forcePremium = false,
  premiumModel = CHAT_MODEL_PREMIUM,
  briefModel = CHAT_MODEL_BRIEF,
}) {
  if (forcePremium || isPremiumResponseMode(responseMode)) {
    return premiumModel;
  }
  if (wasExpanded) {
    return premiumModel;
  }
  if (
    retrievalMaxScore !== undefined &&
    retrievalMaxScore !== null &&
    retrievalMaxScore < LOW_RETRIEVAL_SCORE_PREMIUM
  ) {
    return premiumModel;
  }
  return briefModel;
}

/** OpenAIUsage.type for the model actually selected by selectChatModel. */
function usageTypeForChatSelection({
  chatModel,
  briefModel,
  premiumModel,
  responseMode = "brief",
  retrievalMaxScore,
  wasExpanded = false,
  forcePremium = false,
}) {
  if (briefModel && premiumModel && briefModel === premiumModel) {
    const usedPremium =
      forcePremium ||
      isPremiumResponseMode(responseMode) ||
      wasExpanded ||
      (retrievalMaxScore !== undefined &&
        retrievalMaxScore !== null &&
        retrievalMaxScore < LOW_RETRIEVAL_SCORE_PREMIUM);
    return usedPremium ? "chat" : "brief-chat";
  }
  if (chatModel === briefModel) return "brief-chat";
  if (chatModel === premiumModel) return "chat";
  return "chat";
}

function getContextLimitsForMode(responseMode) {

  console.log("response mode checks :",responseMode);
  if (responseMode === "page_links" || responseMode === "links") {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      maxTotalChars: RAG_MAX_CONTEXT_CHARS_LINKS,
    };
  }
  if (responseMode === "list") {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS_LIST,
      maxTotalChars: RAG_MAX_CONTEXT_CHARS_LIST,
      maxUrls: RAG_LIST_MAX_URLS,
    };
  }
  // Multi-entity / comparison: larger window (2–3 products × topK chunks).
  if (responseMode === "compare") {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      maxTotalChars:
        Number(process.env.RAG_MAX_CONTEXT_CHARS_COMPARE) || 12000,
    };
  }
  if (responseMode === "recommend") {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      maxTotalChars:
        Number(process.env.RAG_MAX_CONTEXT_CHARS_COMPARE) || 12000,
    };
  }
  if (isPremiumResponseMode(responseMode)) {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      maxTotalChars: RAG_MAX_CONTEXT_CHARS,
    };
  }

  console.log(
    "no conditon match then finally return to the default context limits",
    {},
  );
  return {
    maxChunkChars: RAG_MAX_CHUNK_CHARS_BRIEF,
    maxTotalChars: RAG_MAX_CONTEXT_CHARS_BRIEF,
  };
}

// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey:
    process.env.QDRANT_API_KEY
});

class QuestionAnsweringSystem {
  constructor() {
    this.embeddingModel = null;
    this.currentModelName = null;
    this.qdrantClient = qdrantClient;
  }

  // check 2 ---->

  async getEmbeddingModel() {

    try {

      const cfg = await getResolvedModelConfig("embedding");
      const modelName = cfg.model || DEFAULT_EMBEDDING_MODEL;

      if (
        this.embeddingModel &&
        this.currentModelName === modelName
      ) {
        return this.embeddingModel;
      }

      console.log(`Switching embedding model to ${modelName}`);

      this.embeddingModel = new OpenAIEmbeddings({
        openAIApiKey: OPENAI_API_KEY,
        modelName,
      });

      this.currentModelName = modelName;

      return this.embeddingModel;

    } catch (error) {

      console.error(`Error occurred while fetching embedding model: ${error.message}`);
      this.embeddingModel = new OpenAIEmbeddings({
        openAIApiKey: OPENAI_API_KEY,
        modelName: process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      });

      return this.embeddingModel;

    }
  }

  async getChatModelName() {
    try {
      const cfg = await getResolvedModelConfig("chat");
      return cfg.model;
    } catch (error) {
      console.warn(
        `[QueryController] Failed to resolve chat model, falling back to default: ${error.message}`
      );
      return process.env.OPENAI_CHAT_MODEL || CHAT_MODEL_PREMIUM;
    }
  }

  async getBriefChatModelName() {
    try {
      const cfg = await getResolvedModelConfig("brief-chat", ["breif-chat"]);
      return cfg.model;
    } catch (error) {
      console.warn(
        `[QueryController] Failed to resolve brief chat model: ${error.message}`
      );
      return CHAT_MODEL_BRIEF;
    }
  }

  async logOpenAIChatUsage({
    userId,
    agentId,
    conversationId,
    usage,
    modelName,
    type = "chat",
  }) {
    if (!usage) {
      return;
    }

    // `type` is the AiModel category (dynamic). Only normalize typos.
    const category = usageTypeForCategory(type);

    let cfg = null;
    try {
      // Typo alias only — no static category allowlist
      const fallbackCategories =
        category === "brief-chat" ? ["breif-chat"] : [];
      cfg = await getResolvedModelConfig(category, fallbackCategories);
    } catch (error) {
      console.warn(
        `Unable to fetch model record for category "${category}": ${error.message}`
      );
    }

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const cacheTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const costs = computeTokenCosts({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheTokens,
      inputCostPerMillion: cfg?.inputCost || 0,
      outputCostPerMillion: cfg?.outputCost || 0,
      cacheCostPerMillion: cfg?.cacheCost || 0,
    });

    await logOpenAIUsage({
      userId,
      agentId,
      conversationId,
      model: modelName || cfg?.model,
      type: category,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheTokens: cacheTokens,
      totalTokens: usage.total_tokens || 0,
      ...costs,
    });
  }



  // check 2 ----> 

  async getChatHistory(conversationId) {
    try {
      if (!conversationId) {
        return [];
      }
      // Fetch more messages (last 12) for better conversation context
      // This gives enough context to understand conversation flow and reference previous topics
      const messages = await ChatMessage.find({
        conversation_id: conversationId,
      })
        .sort({ createdAt: -1 }) // Newest first to maintain conversation flow
        .limit(CHAT_HISTORY_LIMIT)
        .lean();

      return messages.reverse() || [];
    } catch (error) {
      console.error("Error getting chat history:", error);
      // Return empty array on error to allow processing to continue if possible
      return [];
    }
  }

  async persistRagStateForTurn(
    conversationId,
    {
      routing = {},
      ragState,
      retrievalQuery = null,
      baseForEmbedding = null,
      queryAttributes = {},
      matches = [],
      isOffTopic = false,
      clear = false,
      assistantAnswer = null,
    } = {},
  ) {
    if (!conversationId) return;

    try {
      if (clear || shouldClearRagState(routing)) {
        await clearRagState(conversationId);
        return;
      }

      if (routing.route === ROUTES.ACKNOWLEDGEMENT) {
        await saveRagState(
          conversationId,
          buildAckRagState(ragState, routing),
        );
        return;
      }

      const awaiting = detectSoftOffer(assistantAnswer)
        ? AWAITING_FOLLOW_UP
        : null;

      if (shouldClearEntitiesOnly(routing, isOffTopic)) {
        await saveRagState(
          conversationId,
          buildUpdatedRagState({
            currentState: ragState,
            routing,
            retrievalQuery,
            baseForEmbedding,
            queryAttributes,
            matches: [],
            clearEntities: true,
            awaiting: null,
          }),
        );
        return;
      }

      await saveRagState(
        conversationId,
        buildUpdatedRagState({
          currentState: ragState,
          routing,
          retrievalQuery,
          baseForEmbedding,
          queryAttributes,
          matches,
          awaiting,
          assistantAnswer,
        }),
      );
    } catch (error) {
      console.warn(
        `[QueryController] Failed to persist ragState for ${conversationId}: ${error.message}`,
      );
    }
  }

  formatChatHistory(messages, currentQuestion = null, options = {}) {
    const historyLimit = options.historyLimit ?? CHAT_HISTORY_LIMIT;
    if (!messages || messages.length === 0) {
      return "No previous conversation.";
    }

    const limitedMessages =
      historyLimit > 0 && messages.length > historyLimit
        ? messages.slice(-historyLimit)
        : messages;

    // Filter out the current question if it's already in the history (shouldn't happen, but safety check)
    const filteredMessages = currentQuestion
      ? limitedMessages.filter(
        (msg) => msg.message?.trim() !== currentQuestion.trim(),
      )
      : limitedMessages;

    if (filteredMessages.length === 0) {
      return "No previous conversation.";
    }

    // Format messages in a clear conversational flow
    // Canonical sender types: visitor, client, ai, system, humanAgent
    const formattedMessages = filteredMessages.map((msg, index) => {
      const senderType = msg.sender_type || "unknown";
      const message = stripHtmlForContext(msg.message || "");

      let role = "User";
      if (
        senderType === "ai" ||
        senderType === "bot" ||
        senderType === "assistant"
      ) {
        role = "Assistant";
      } else if (senderType === "visitor" || senderType === "user") {
        role = "User";
      } else if (
        senderType === "humanAgent" ||
        senderType === "client" ||
        senderType === "agent"
      ) {
        role = "Agent";
      } else if (senderType === "system") {
        role = "System";
      }

      return `${role}: ${message}`;
    });

    // Add context about conversation flow
    const conversationFlow = formattedMessages.join("\n\n");

    // Add helpful context for longer conversations
    if (filteredMessages.length > 10) {
      return `Previous conversation (last ${filteredMessages.length} messages, showing most recent context):\n\n${conversationFlow}\n\n[Note: This is a longer conversation. Reference key points from earlier messages if the user asks follow-up questions or refers back to previous topics.]`;
    } else if (filteredMessages.length > 5) {
      return `Previous conversation:\n\n${conversationFlow}`;
    }

    return conversationFlow;
  }

  // Prefer user-configured branding over auto-scraped page titles (blog posts often
  // title a product, e.g. "Clever AdWords" on favseo.com, not the site name).
  resolveCompanyName({ websiteData, widgetData, agentData }) {
    const configured =
      (widgetData?.organisation || "").trim() ||
      (widgetData?.titleBar || "").trim() ||
      (agentData?.website_name || "").trim() ||
      (agentData?.agentName || "").trim();
    if (configured) return configured;
    return (websiteData?.company_name || "").trim() || "the company";
  }

  buildLightweightResponseContext({
    companyName,
    userMessage,
    routing,
    websiteLanguage,
    options = {},
  }) {
    return {
      companyName,
      userMessage,
      routingUserLanguage: routing?.userLanguage,
      visitorLocale: options.visitorLocale,
      websiteLanguage,
    };
  }

  async respondToGreeting({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
    userId,
    agentId,
  }) {
    const { answer, language, source } = await generateGreeting({
      companyName,
      userMessage: question,
      userLanguage: routing.userLanguage,
      websiteLanguage,
      visitorLocale: options.visitorLocale,
      userId,
      agentId,
      conversationId,
    });

    console.log(
      `[QueryController] Greeting response via ${source} (${language || routing.userLanguage})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: false,
    };
  }

  async respondToAccidental({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
    userId,
    agentId,
  }) {
    const { answer, language, source } = await generateAccidentalReply({
      companyName,
      userMessage: question,
      userLanguage: routing.userLanguage,
      websiteLanguage,
      visitorLocale: options?.visitorLocale,
      userId,
      agentId,
      conversationId,
    });

    console.log(
      `[QueryController] Accidental response via ${source} (${language || routing.userLanguage})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: false,
    };
  }

  async respondToLiveAgent({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
    userId,
    agentId,
  }) {
    const { answer, language, source } = await generateLiveAgentReply({
      companyName,
      userMessage: question,
      userLanguage: routing.userLanguage,
      websiteLanguage,
      visitorLocale: options?.visitorLocale,
      userId,
      agentId,
      conversationId,
    });

    console.log(
      `[QueryController] Live-agent response via ${source} (${language || routing.userLanguage})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: true,
    };
  }

  async respondToOffTopic({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
    isIrrelevant = false,
    userId,
    agentId,
  }) {
    const { answer, language, source } = await generateOffTopicReply({
      companyName,
      userMessage: question,
      userLanguage: routing?.userLanguage,
      websiteLanguage,
      visitorLocale: options?.visitorLocale,
      isIrrelevant,
      userId,
      agentId,
      conversationId,
    });

    console.log(
      `[QueryController] Off-topic response via ${source} (${language || routing?.userLanguage || "en"})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: false,
    };
  }

  isClearlyOnTopicCompanyQuestion(question, companyName) {
    return detectClearlyOnTopicQuestion(question, companyName);
  }

  isCompanyIdentityQuestion(question, companyName) {
    return detectCompanyIdentityQuestion(question, companyName);
  }

  buildWebsiteDataFallbackContext(websiteData, companyName) {
    const parts = [];
    const type = websiteData?.company_type;
    const industry = websiteData?.industry;
    const founded = websiteData?.founded_year;
    const valueProp = websiteData?.value_proposition;
    const services = websiteData?.services_list || [];
    const categories = websiteData?.categories_list || [];

    if (type) parts.push(`Company type: ${type}`);
    if (industry) parts.push(`Industry: ${industry}`);
    if (founded) parts.push(`Founded: ${founded}`);
    if (valueProp) parts.push(`Value proposition: ${valueProp}`);
    if (services.length > 0) {
      parts.push(
        `Services/products:\n${services.map((s) => `- ${s}`).join("\n")}`,
      );
    }
    if (categories.length > 0) {
      const categoryLines = categories
        .map((category) => {
          const name = category?.name || category;
          if (!name) return null;
          return `- ${name}${category?.url ? ` (${category.url})` : ""}`;
        })
        .filter(Boolean);
      if (categoryLines.length > 0) {
        parts.push(
          `Navigation categories and collections:\n${categoryLines.join("\n")}`,
        );
      }
    }

    if (parts.length === 0) {
      return `Answer as a representative of ${companyName}. Describe what ${companyName} offers based on your role as their support assistant. If specific details are not in the profile, give a helpful overview and invite follow-up questions about products, services, or pricing.`;
    }

    return `Company profile for ${companyName}:\n\n${parts.join("\n\n")}`;
  }

  async answerOnTopicWithFallback({
    question,
    relevantMatches,
    queryResponse,
    requestedTopK,
    getChatHistoryFormatted,
    companyName,
    websiteData,
    langOpts,
    wasExpanded,
    maxScore,
    userId,
    agentId,
    conversationId = null,
  }) {
    let matches = relevantMatches;
    if (matches.length === 0 && queryResponse.length > 0) {
      matches = [...queryResponse]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(requestedTopK, 3));
      console.log(
        `[QueryController] On-topic fallback: using ${matches.length} best available chunks (max score ${maxScore.toFixed(3)})`,
      );
    }

    const identityQuestion = this.isCompanyIdentityQuestion(
      question,
      companyName,
    );
    const historyLimit = identityQuestion
      ? CHAT_HISTORY_LIMIT
      : CHAT_HISTORY_LIMIT_BRIEF;
    const sharedOpts = {
      ...langOpts,
      wasExpanded,
      retrievalMaxScore: maxScore,
      forcePremium: identityQuestion || maxScore < LOW_RETRIEVAL_SCORE_PREMIUM,
    };

    if (matches.length > 0) {
      const contextLimits = getContextLimitsForMode("brief");
      const ragContext = this.getRelevantContext(matches, {
        ...contextLimits,
        maxTotalChars: RAG_MAX_CONTEXT_CHARS,
      });
      const profileContext = this.buildWebsiteDataFallbackContext(
        websiteData,
        companyName,
      );
      const combinedContext = `${profileContext}\n\n---\n\nRetrieved website content:\n${ragContext}`;

      const result = await this.generateAnswer(
        question,
        combinedContext,
        getChatHistoryFormatted(historyLimit),
        companyName,
        websiteData,
        sharedOpts,
      );
      this.logAnswerUsage(userId, agentId, result, conversationId);
      return { answer: result.answer, matches };
    }

    const fallbackContext = this.buildWebsiteDataFallbackContext(
      websiteData,
      companyName,
    );
    console.log(
      `[QueryController] On-topic fallback: answering from WebsiteData profile only`,
    );
    const result = await this.generateAnswer(
      question,
      fallbackContext,
      getChatHistoryFormatted(historyLimit),
      companyName,
      websiteData,
      sharedOpts,
    );
    this.logAnswerUsage(userId, agentId, result, conversationId);
    return { answer: result.answer, matches: [] };
  }

  logAnswerUsage(userId, agentId, { usage, model, usageType, type } = {}, conversationId = null) {
    if (!usage) return;
    this.logOpenAIChatUsage({
      userId,
      agentId,
      conversationId,
      usage,
      modelName: model || CHAT_MODEL_BRIEF,
      type: usageType || type || "chat",
    }).catch((err) =>
      console.warn(`[QueryController] Error logging chat usage: ${err.message}`)
    );
  }

  async generateAnswerFromMatches({
    question,
    matches,
    chatHistory,
    organisation,
    websiteData,
    answerOptions = {},
  }) {

        console.log("generateAnswerFromMatches : ",answerOptions);
    const {
      responseMode = "brief",
      requestedCount = 5,
      wantsProductUrls = false,
      userId: answerUserId = null,
      agentId: answerAgentId = null,
    } = answerOptions;

    // console.log("generate answer from matches : ", matches);


    const effectiveMode =
      wantsProductUrls && responseMode === "brief" ? "list" : responseMode;

    console.log("effectiveMode : ", effectiveMode);

    if (effectiveMode === "contact" && USE_LIGHTWEIGHT_RESPONSES) {
      const contactResult = await generateContactResponse({
        companyName: organisation,
        userMessage: question,
        userLanguage: answerOptions.userLanguage,
        matches,
        userId: answerUserId,
        agentId: answerAgentId,
        conversationId: answerOptions.conversationId || null,
      });

      if (contactResult?.answer) {
        console.log(
          `[QueryController] Contact response via ${contactResult.source} (${contactResult.language})`,
        );
        return {
          answer: contactResult.answer,
          usage: null,
          model: null,
          source: contactResult.source,
        };
      }
    }

    const contextLimits = {
      ...getContextLimitsForMode(effectiveMode),
      ...(answerOptions.maxTotalChars
        ? { maxTotalChars: answerOptions.maxTotalChars }
        : {}),
    };

    console.log("context limits : ", contextLimits);
    let context;

    if (answerOptions.prebuiltContext) {
      context = answerOptions.prebuiltContext;
    } else if (effectiveMode === "page_links" || effectiveMode === "links") {
      context = this.buildCompactPageLinksContext(matches, {
        ...contextLimits,
        requestedCount,
      });
    } else if (effectiveMode === "list") {
      context = this.buildInPageListContext(matches, {
        ...contextLimits,
        requestedCount,
      });
    } else if (
      answerOptions.contextMode === "page_merge" ||
      effectiveMode === "page_merge"
    ) {
      // Whole-page merge only when the plan explicitly requests it (e.g. COMPARE)
      context = await this.buildPageMergeContext(matches, {
        ...contextLimits,
        collectionName: answerOptions.collectionName,
        userId: answerOptions.userId,
        agentId: answerOptions.agentId,
      });
    } else {
      // Industry default: top ranked chunks only (no whole-page expansion)
      context = this.getRelevantContext(matches, contextLimits);
    }

    console.log(
      `[QueryController] Context: ${context.length} chars, mode=${effectiveMode}, matches=${matches?.length ?? 0}`,
    );

    return this.generateAnswer(
      question,
      context,
      chatHistory,
      organisation,
      websiteData,
      answerOptions,
    );
  }

  isSimpleGreeting(question) {
    return isPureGreeting(question);
  }

  isAccidentalOrTestMessage(question) {
    return isGibberishOrAccidentalMessage(question);
  }

  // Detect if the visitor is asking to connect to a live agent
  isAgentConnectionRequest(question) {
    const normalizedQuestion = question.toLowerCase().trim();

    // Keywords and phrases that indicate a request to speak with an agent
    const agentKeywords = [
      "speak to agent",
      "talk to agent",
      "connect to agent",
      "live agent",
      "human agent",
      "real person",
      "speak to human",
      "talk to human",
      "connect to human",
      "speak to person",
      "talk to person",
      "connect to person",
      "speak to someone",
      "talk to someone",
      "connect to someone",
      "agent please",
      "human please",
      "person please",
      "agent",
      "human",
      "representative",
      "support agent",
      "customer service",
      "customer support",
      "live chat",
      "live support",
      "can i speak",
      "can i talk",
      "i want to speak",
      "i want to talk",
      "need to speak",
      "need to talk",
      "want to speak",
      "want to talk",
      "let me speak",
      "let me talk",
      "transfer to agent",
      "transfer to human",
      "transfer to person",
    ];

    // Check if question contains any agent connection keywords
    return agentKeywords.some((keyword) =>
      normalizedQuestion.includes(keyword),
    );
  }

  // Determine appropriate max_tokens based on query type
  // Token budget is driven first by the router's subIntent (already resolved
  // by the LLM), then by a small set of language-agnostic signals.
  // This avoids the English-only keyword list that mis-bucketed specific pricing
  // queries ("give me its pricing" → 400) and gave non-English queries the
  // bare 300-token default.
  determineMaxTokens(question, responseMode = "brief", subIntent = null) {

    return 1200;
    // ── Tier 1: structural modes resolved by LLM router ───────────────────
    if (responseMode === "list" || subIntent === "IN_PAGE_LIST") {
      const count = this.extractRequestedCount(question, 5);
      return Math.min(2000, 400 + count * 120);
    }
    if (responseMode === "contact" || subIntent === "CONTACT_INFO") {
      return 800;
    }
    if (responseMode === "page_links" || subIntent === "PAGE_LINKS") {
      const count = this.extractRequestedCount(question, 5);
      return Math.min(1200, 300 + count * 100);
    }
    // Comparison / multi-entity answers need more room for side-by-side coverage.
    if (responseMode === "compare" || subIntent === "COMPARE") {
      return 1200;
    }
    if (responseMode === "recommend") {
      return 1000;
    }

    // ── Tier 2: SEMANTIC_RAG — language-agnostic secondary signals ─────────

    // Pricing intent: currency symbols + multilingual price words
    // EN/ES/FR/DE/JA/RU/HI covered so non-English pricing queries get 600 too
    const hasPricingIntent =
      /\$|€|£|¥|₹/.test(question) ||
      /\b(price|pricing|cost|msrp|how\s+much|rate|rates|fee|fees|tariff)\b/i.test(
        question,
      ) ||
      /\b(precio|precios|coste|costos?|cuánto|tarifa)\b/i.test(question) ||
      /\b(prix|tarif|coût|combien)\b/i.test(question) ||
      /\b(preis|preise|kosten|was\s+kostet)\b/i.test(question) ||
      /価格|値段|料金|いくら/.test(question) ||
      /цена|стоимость|сколько\s+стоит/.test(question) ||
      /कीमत|मूल्य|दाम|कितना/.test(question);

    if (hasPricingIntent) return 600;

    // Detailed explanation
    const isDetailedRequest =
      /\b(explain|describe|detail|detailed|comprehensive|complete|full|everything|how\s+does|how\s+do|what\s+are|what\s+is)\b/i.test(
        question,
      );

    if (isDetailedRequest) return 600;

    // Numbered quantity request  e.g. "give me 10 options"
    const numericPattern =
      /\b(\d+)\s+(best|top|ways|steps|items?|products?|options?|examples?|links?|recommendations?)\b/i;
    if (numericPattern.test(question)) {
      const numberMatch = question.match(/\b(\d+)\b/);
      const qty = numberMatch ? parseInt(numberMatch[1], 10) : 5;
      const isLinkRequest = /\b(link|links|url|urls|page|pages)\b/i.test(
        question,
      );
      if (isLinkRequest) return Math.min(2000, 300 + qty * 150);
      return Math.min(1200, 300 + qty * 80);
    }

    // General list request
    const isListRequest = /\b(list|all|every|each)\b/i.test(question);
    if (isListRequest) return 500;

    // Default for focused single-fact queries
    return 300;
  }

  /**
   * Classify retrieval strategy:
   * - IN_PAGE_LIST: products/items/prices on a page (e.g. featured products on homepage)
   * - CONTACT_INFO: social media, phone, email, address, hours (footer content)
   * - PAGE_LINKS: navigation — list of distinct pages/URLs
   * - SEMANTIC: default factual Q&A via embeddings
   */
  classifyQueryIntent(query) {
    const q = (query || "").toLowerCase();

    const wantsInPageList =
      /\b(featured|homepage|home\s*page|main\s*page)\b/.test(q) ||
      /\b(list|show|give\s+me|what\s+are|tell\s+me)\b[\s\S]{0,50}\b(products?|items?)\b/.test(
        q,
      ) ||
      /\b(all|every|each)\b[\s\S]{0,40}\b(products?|items?)\b/.test(q) ||
      /\b(products?|items?)\b[\s\S]{0,40}\b(price|prices|cost|pricing)\b/.test(
        q,
      ) ||
      /\b(price|prices|cost|pricing)\b[\s\S]{0,40}\b(products?|items?)\b/.test(
        q,
      ) ||
      /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
        q,
      );

    const wantsContactInfo =
      /\bsocial\s*media\b/.test(q) ||
      /\b(facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest)\b/.test(
        q,
      ) ||
      /\b(follow\s+us|find\s+us\s+on)\b/.test(q) ||
      /\b(office\s+hours|business\s+hours|phone\s+number|mailing\s+address)\b/.test(
        q,
      ) ||
      (/\b(how\s+(?:do\s+i\s+)?contact|contact\s+(?:info|details|number)|reach\s+us|call\s+us)\b/.test(
        q,
      ) &&
        !/\b(refund|return|policy|billing|order|shipping|warranty|cancel|product)\b/.test(
          q,
        )) ||
      (/\b(phone|email|e-mail|address|hours|fax|mailing)\b/.test(q) &&
        !/\b(support\s+ticket|submit\s+a\s+ticket|product|refund|policy|billing|order)\b/.test(
          q,
        )) ||
      (/\b(give\s+me|show\s+me|what\s+are|list)\b/.test(q) &&
        /\bsocial\b/.test(q)) ||
      isContactIntentQuestion(query);

    const wantsPageLinks =
      !wantsContactInfo &&
      (isCategoryNavigationRequest(q) ||
        (/\b(links?|urls?)\b/.test(q) &&
          !/\b(social\s*media|social)\b/.test(q) &&
          /\b(list|show|give\s+me|all|every|how\s+many)\b/.test(q)) ||
        /\bshow\s+me\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
        /\blist\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
        (/\b(pages?)\b/.test(q) &&
          /\b(list|show|give|all|site|website)\b/.test(q) &&
          !wantsInPageList) ||
        (/\b(collections?)\b/.test(q) &&
          /\b(list|show|all|pages?|links?)\b/.test(q) &&
          !/\b(products?|items?|featured|price|prices)\b/.test(q)));

    const hasListHint = /\b(list|show|give\s+me|how\s+many|all\b|top\b)\b/.test(
      q,
    );
    const hasProductWord = /\b(products?|items?)\b/.test(q);

    if (wantsInPageList) return "IN_PAGE_LIST";
    if (wantsContactInfo) return "CONTACT_INFO";
    if (wantsPageLinks) return "PAGE_LINKS";
    if (hasListHint && hasProductWord) return "IN_PAGE_LIST";
    return "SEMANTIC";
  }

  /** @deprecated Use classifyQueryIntent */
  detectIntent(query) {
    const intent = this.classifyQueryIntent(query);
    return intent === "PAGE_LINKS" ? "STRUCTURAL" : intent;
  }

  isHomepageUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const path = new URL(url).pathname;
      return path === "/" || path === "";
    } catch {
      return (
        /\/$/.test(url) &&
        !url.replace(/^https?:\/\/[^/]+/, "").includes("/", 1)
      );
    }
  }

  mergeRetrievalResults(semanticMatches, keywordPoints) {
    const seen = new Set();
    const merged = [];

    const addMatch = (match, defaultScore = 0) => {
      const payload = match.payload || match;
      const text = payload?.text || payload?.pageContent || "";
      const url = payload?.url || "";
      const parentId = payload?.parent_id;
      const key = parentId
        ? `parent::${parentId}`
        : `${url}::${text.slice(0, 120)}`;
      if (!text && !payload?.parent_text) return;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({
        id: match.id || key,
        score: match.score ?? defaultScore,
        payload,
      });
    };

    for (const m of semanticMatches || []) addMatch(m, m.score);
    for (const p of keywordPoints || []) {
      addMatch({ id: p.id, payload: p.payload || p }, 0.45);
    }

    return merged.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * Expand retrieval with additional parent chunks for matched product_id values.
   */
  async expandByProductIds(
    collectionName,
    matches,
    userId,
    agentId,
    { maxProducts = 2, maxParentsPerProduct = 4 } = {},
  ) {
    if (!matches?.length || !userId || !collectionName) return matches || [];

    const productIds = [];
    for (const m of matches) {
      const pid = m.payload?.product_id;
      if (pid && !productIds.includes(pid)) productIds.push(pid);
      if (productIds.length >= maxProducts) break;
    }
    if (productIds.length === 0) return matches;

    const seenParents = new Set();
    for (const m of matches) {
      const p = m.payload || {};
      const key =
        p.parent_id || `${p.url}::${String(p.text || "").slice(0, 80)}`;
      seenParents.add(key);
    }

    const expanded = [...matches];

    for (const productId of productIds) {
      const must = [
        { key: "user_id", match: { value: userId.toString() } },
        { key: "product_id", match: { value: productId } },
      ];
      if (agentId) {
        must.push({ key: "agent_id", match: { value: agentId.toString() } });
      }

      try {
        const res = await this.qdrantClient.scroll(collectionName, {
          limit: 64,
          with_payload: true,
          filter: { must },
        });

        const parentsAdded = new Set();
        for (const pt of res.points || []) {
          const payload = pt.payload || {};
          const parentKey =
            payload.parent_id ||
            `${payload.url}::${String(payload.parent_text || payload.text || "").slice(0, 80)}`;
          if (seenParents.has(parentKey) || parentsAdded.has(parentKey)) {
            continue;
          }
          if (parentsAdded.size >= maxParentsPerProduct) break;
          seenParents.add(parentKey);
          parentsAdded.add(parentKey);
          expanded.push({
            id: pt.id,
            score: 0.38,
            payload,
          });
        }
      } catch (err) {
        console.warn(
          `[QueryController] expandByProductIds failed for ${productId}: ${err.message}`,
        );
      }
    }

    return expanded.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  applyAttributeRerank(
    matches,
    queryAttributes,
    label = "hybrid",
    lexicalTerms = [],
    softBoosts = [],
  ) {
    if (!matches?.length || !queryAttributes) return matches || [];
    const before = matches.slice(0, 8);
    const reranked = rerankByAttributes(matches, queryAttributes, {
      subIntent: queryAttributes.subIntent,
      lexicalTerms:
        lexicalTerms?.length > 0
          ? lexicalTerms
          : queryAttributes.keywords || [],
      softBoosts,
    });
    logRerankStats(label, before, reranked);
    return reranked;
  }

  /**
   * Plan-driven retrieval: dense+sparse RRF (via queryQdrant), multi-signal rerank,
   * optional product expand. No hard size filters. No absolute RRF score gate.
   */
  async runHybridRetrieval({
    collectionName,
    userIdString,
    semanticTopK,
    catalogKeywords,
    getQuestionEmbedding,
    queryAttributes,
    queryText = "",
    agentId = null,
    plan = null,
  }) {
    const policy = plan?.retrievalPolicy || {};
    const topK = semanticTopK || policy.semanticTopK || 60;
    const lexicalTerms =
      plan?.lexicalTerms?.length > 0
        ? plan.lexicalTerms
        : catalogKeywords || queryAttributes?.keywords || [];

    // Keyword payload scroll only when plan opts in (default: false — sparse RRF handles lexical)
    const runKeyword =
      Boolean(policy.useKeywordScroll) &&
      needsKeywordRetrieval(queryAttributes) &&
      lexicalTerms.length > 0;

    const [vectorResults, keywordPoints] = await Promise.all([
      this.queryQdrant(
        collectionName,
        await getQuestionEmbedding(),
        topK,
        userIdString,
        {
          queryText:
            queryText ||
            queryAttributes?.retrievalQuery ||
            queryAttributes?.keywordSource ||
            "",
          agentId,
          hardFilters: policy.hardFilters || [],
          lexicalTerms,
        },
      ),
      runKeyword
        ? this.structuralFetchByKeywords(
          collectionName,
          lexicalTerms,
          userIdString,
          Math.min(80, RAG_KEYWORD_FETCH_MAX),
        )
        : Promise.resolve([]),
    ]);

    if (runKeyword) {
      console.log(
        `[QueryController] Hybrid retrieval: ${vectorResults.length} vector + ${keywordPoints.length} keyword hits`,
      );
    } else {
      console.log(
        `[QueryController] RRF retrieval: ${vectorResults.length} candidates (prefetch depth=${topK}, keyword scroll off)`,
      );
    }

    const merged = this.mergeRetrievalResults(vectorResults, keywordPoints);
    const expanded = await this.expandByProductIds(
      collectionName,
      merged,
      userIdString,
      agentId,
    );
    return this.applyAttributeRerank(
      expanded,
      queryAttributes || plan?.queryAttributes,
      "hybrid",
      lexicalTerms,
      policy.softBoosts || [],
    );
  }

  /**
   * Soft catalog preference for list mode. Never hard-drops all results on size miss.
   */
  selectCatalogMatches(matches, queryAttributes, { strictSize = false } = {}) {
    if (!matches?.length) return [];
    if (!queryAttributes?.sizes?.length) {
      return matches;
    }
    const sized = filterMatchesBySizes(matches, queryAttributes.sizes, {
      strict: false,
    });
    if (strictSize) {
      const strict = filterMatchesBySizes(matches, queryAttributes.sizes, {
        strict: true,
      });
      return strict.length > 0 ? strict : sized;
    }
    return sized;
  }

  buildCatalogListResult(matches, companyName, requestedCount) {
    const listLimits = getContextLimitsForMode("list");
    const contextBlocks = this.buildInPageListContext(matches, {
      ...listLimits,
      requestedCount,
    });
    return {
      context: `The user wants a complete list of items from ${companyName}'s website matching their request. Use ONLY the content below. List EVERY matching item in readable HTML. For each item, show labeled Name, Price, and Link fields in that order. Price must be the current selling/sale/"Now" amount — never a crossed-out original, Was, MSRP, or compare-at price when a lower current price is also present. Write "Not listed" or "Not available" when a value is absent; never invent a value. Do not skip items. Do not say information is unavailable if it appears below. Do not suggest other sizes unless the user asked for alternatives.\n\n${contextBlocks}`,
      matches,
      responseMode: "list",
      requestedCount,
    };
  }


  prioritizeFooterChunks(matches) {
    const footer = [];
    const rest = [];
    for (const m of matches || []) {
      const text = (m.payload?.text || "").toLowerCase();
      if (text.includes("footer links")) {
        footer.push(m);
      } else {
        rest.push(m);
      }
    }
    return [...footer, ...rest];
  }

  getMaxSemanticScore(matches) {
    if (!matches || matches.length === 0) return 0;
    return Math.max(...matches.map((m) => m.score ?? 0));
  }
  isPrimarilyContactQuestion(question) {
    return detectPrimarilyContactQuestion(question);
  }

  countStrongStructuralHits(keywords, points) {
    const strong = (keywords || []).filter((k) => k.length >= 4);
    if (strong.length === 0 || !points || points.length === 0) return 0;

    let hits = 0;
    for (const p of points) {
      const payload = p.payload || p;
      const url = (payload.url || "").toLowerCase();
      const title = (payload.title || "").toLowerCase();
      if (strong.some((k) => url.includes(k) || title.includes(k))) {
        hits += 1;
      }
    }
    return hits;
  }

  buildInPageListContext(matches, options = {}) {
    const maxChunkChars = options.maxChunkChars ?? RAG_MAX_CHUNK_CHARS_LIST;
    const maxTotalChars = options.maxTotalChars ?? RAG_MAX_CONTEXT_CHARS_LIST;
    const requestedCount = options.requestedCount ?? 5;
    const maxUrls = Math.min(
      options.maxUrls ?? RAG_LIST_MAX_URLS,
      Math.max(requestedCount * 2, 10),
    );

    const byUrl = new Map();

    for (const match of matches || []) {
      const payload = match.payload || {};
      const url = payload.url || "unknown";
      const title = payload.title || url;
      const text = stripHtmlForContext(
        payload.text || payload.pageContent || "",
      );
      if (!text) continue;

      const score = match.score ?? 0;
      if (!byUrl.has(url)) {
        byUrl.set(url, { title, url, chunks: [] });
      }
      const entry = byUrl.get(url);
      if (!entry.chunks.some((c) => c.text === text)) {
        entry.chunks.push({ text, score });
      }
    }

    const sortedUrls = Array.from(byUrl.values())
      .map((entry) => ({
        ...entry,
        bestScore: Math.max(...entry.chunks.map((c) => c.score ?? 0), 0),
      }))
      .sort((a, b) => b.bestScore - a.bestScore)
      .slice(0, maxUrls);

    const blocks = [];
    let totalChars = 0;

    for (const { title, url, chunks } of sortedUrls) {
      const best = pickBestChunkForUrl(chunks);
      let text = best.text;
      if (text.length > maxChunkChars) {
        text = `${text.slice(0, maxChunkChars)}…`;
      }

      const block =
        url && url !== "unknown"
          ? `Source: ${title} (${url})\n---\n${text}\n---`
          : text;

      if (totalChars + block.length > maxTotalChars) break;

      blocks.push(block);
      totalChars += block.length;
    }

    return blocks.join("\n\n");
  }

  buildCompactPageLinksContext(matches, options = {}) {
    const maxTotalChars = options.maxTotalChars ?? RAG_MAX_CONTEXT_CHARS_LINKS;
    const requestedCount = options.requestedCount ?? 5;
    const maxItems = Math.min(
      options.maxUrls ?? RAG_LIST_MAX_URLS,
      Math.max(requestedCount, 5),
    );

    const sorted = [...(matches || [])].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0),
    );
    const seen = new Set();
    const pages = [];

    for (const match of sorted) {
      const payload = match.payload || {};
      const url = payload.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push(payload);
      if (pages.length >= maxItems) break;
    }

    const lines = [];
    let totalChars = 0;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const url = p.url || "";
      const title = p.title || url || `Page ${i + 1}`;
      const isNavigationList = p.entity_type === "category_list";
      const navigationText = String(p.parent_text || p.text || "").trim();
      let line =
        isNavigationList && navigationText
          ? `${i + 1}. ${title}\n${navigationText}`
          : `${i + 1}. ${title} — ${url}`;
      const remainingChars = Math.max(0, maxTotalChars - totalChars - 1);
      if (line.length > remainingChars && isNavigationList) {
        line = line.slice(0, remainingChars);
      }
      if (totalChars + line.length + 1 > maxTotalChars) break;
      lines.push(line);
      totalChars += line.length + 1;
    }

    return lines.join("\n");
  }

  matchesToSources(matches, maxSources = MAX_ANSWER_SOURCES) {
    const seenSourceKeys = new Set();
    const sorted = [...(matches || [])].sort(
      (a, b) => (b.score || 0) - (a.score || 0),
    );
    const sources = [];
    const limit = Math.max(1, Number(maxSources) || MAX_ANSWER_SOURCES);

    for (const match of sorted) {
      if (sources.length >= limit) break;

      const payload = match.payload || {};
      const sourceType = payload.type !== undefined ? payload.type : null;
      const title = payload.title || payload.url || null;
      const url = payload.url || null;

      if (sourceType === null && !title && !url) continue;

      const key = url || title;
      if (!key || seenSourceKeys.has(key)) continue;

      seenSourceKeys.add(key);
      sources.push({ type: sourceType, title, url });
    }

    return sources;
  }

  extractRequestedCount(question, fallback = 5) {
    const q = (question || "").toLowerCase();
    const withoutSizes = q
      .replace(/\b\d{1,2}\s*-\s*\d{1,2}\s*mm\b/gi, " ")
      .replace(/\b\d{1,2}\s*mm\b/gi, " ")
      .replace(/\b\d{1,2}-\d{1,2}mm\b/gi, " ");

    const quantityMatch =
      withoutSizes.match(
        /\b(?:top|first|give\s+me|show\s+me|list|need)\s+(\d+)\b/i,
      ) ||
      withoutSizes.match(
        /\b(\d+)\s+(?:products?|items?|options?|styles?|lashes?|urls?|links?)\b/i,
      );

    if (quantityMatch) {
      const parsed = parseInt(quantityMatch[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 50) {
        return parsed;
      }
    }

    return fallback;
  }

  buildCatalogKeywords(keywordSource, queryNorm = {}) {
    const fromSource = this.extractKeywords(keywordSource);
    const fromNorm = queryNorm.retrievalKeywords || [];
    const sizeKeywords = (queryNorm.sizes || []).flatMap((s) => {
      const compact = s.replace(/\s/g, "");
      const numOnly = compact.replace(/mm$/i, "");
      return [compact, numOnly].filter((k) => k.length > 2);
    });

    return [
      ...new Set([
        ...fromSource,
        ...fromNorm,
        ...buildRetrievalKeywords(keywordSource, queryNorm.sizes || []),
        ...sizeKeywords,
        ...(queryNorm.morphologyHints || []),
      ]),
    ].filter((k) => k.length > 2);
  }

  extractKeywords(query) {
    const stop = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "of",
      "for",
      "to",
      "in",
      "on",
      "with",
      "all",
      "show",
      "list",
      "give",
      "me",
      "links",
      "url",
      "urls",
      "how",
      "many",
      "top",
      "best",
      "your",
      "their",
      "our",
      "my",
      "there",
      "is",
      "are",
      "do",
      "you",
      "please",
      "products",
      "collections",
      "link",
      "give",
      "items",
      "item",
      "what",
      "when",
      "where",
      "have",
      "get",
      "can",
      "could",
      "would",
      "will",
      "that",
      "this",
      "from",
      "about",
      "been",
      "media",
    ]);
    return (query || "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w));
  }

  dedupeByUrl(points) {
    const map = new Map();
    for (const p of points) {
      const url = p?.payload?.url;
      if (!url) continue;
      if (!map.has(url)) {
        map.set(url, p.payload);
      }
    }
    return Array.from(map.values());
  }

  async structuralFetchByKeywords(
    collectionName,
    keywords,
    userId,
    limit = 500,
  ) {
    if (!keywords || keywords.length === 0) return [];

    const filter =
      userId && userId.toString().length
        ? { must: [{ key: "user_id", match: { value: userId.toString() } }] }
        : undefined;

    let points = [];
    let nextPage = null;
    const batchSize = Math.min(limit, 256);

    while (points.length < limit) {
      const params = {
        limit: batchSize,
        with_payload: true,
        ...(filter ? { filter } : {}),
        ...(nextPage ? { offset: nextPage } : {}),
      };

      const res = await this.qdrantClient.scroll(collectionName, params);
      const batch = res.points || [];

      const filtered = batch.filter((p) => {
        const url = (p.payload?.url || "").toLowerCase();
        const title = (p.payload?.title || "").toLowerCase();
        const text = (p.payload?.text || "").toLowerCase();
        const searchTerms = (p.payload?.search_terms || []).map((t) =>
          String(t).toLowerCase(),
        );
        const payloadSizes = (p.payload?.sizes || []).map((s) =>
          String(s).toLowerCase(),
        );
        const payloadCollections = (p.payload?.collections || []).map((c) =>
          String(c).toLowerCase(),
        );

        return keywords.some((k) => {
          const key = k.toLowerCase();
          if (url.includes(key) || title.includes(key) || text.includes(key)) {
            return true;
          }
          if (
            payloadSizes.some((s) => s.includes(key) || key.includes(s)) ||
            payloadCollections.some((c) => c.includes(key) || key.includes(c))
          ) {
            return true;
          }
          return searchTerms.some(
            (term) => term.includes(key) || key.includes(term),
          );
        });
      });

      points.push(...filtered);

      if (!res.next_page_offset) break;
      nextPage = res.next_page_offset;
    }

    return points;
  }

  async generateAnswer(
    question,
    context,
    chatHistory,
    organisation,
    websiteData = null,
    answerOptions = {},
  ) {
    const {
      responseMode = "brief",
      requestedCount = 5,
      userLanguage,
      wantsProductUrls = false,
      retrievalMaxScore,
      wasExpanded = false,
      forcePremium = false,
      subIntent = null,
    } = answerOptions;

    const effectiveMode =
      wantsProductUrls && responseMode === "brief" ? "list" : responseMode;

    const [premiumCfg, briefCfg] = await Promise.all([
      getResolvedModelConfig("chat"),
      getResolvedModelConfig("brief-chat", ["breif-chat"]),
    ]);
    const premiumModel = premiumCfg.model || CHAT_MODEL_PREMIUM;
    const briefModel = briefCfg.model || CHAT_MODEL_BRIEF;

    const chatModel = selectChatModel({
      responseMode: effectiveMode,
      retrievalMaxScore,
      wasExpanded,
      forcePremium,
      premiumModel,
      briefModel,
    });
    const usageType = usageTypeForChatSelection({
      chatModel,
      briefModel,
      premiumModel,
      responseMode: effectiveMode,
      retrievalMaxScore,
      wasExpanded,
      forcePremium,
    });

    const useMediumPrompt =
      effectiveMode === "brief" &&
      (forcePremium ||
        (retrievalMaxScore !== undefined &&
          retrievalMaxScore !== null &&
          retrievalMaxScore < LOW_RETRIEVAL_SCORE_PREMIUM));
    const promptTier = useMediumPrompt ? "medium" : "compact";

    let systemPrompt;
    if (websiteData && (organisation || websiteData.company_name)) {
      systemPrompt = buildSystemPrompt(websiteData, organisation, {
        tier: promptTier,
      });
    } else {
      systemPrompt = buildFallbackPrompt(organisation, promptTier);
    }

    systemPrompt = appendReplyLanguage(systemPrompt, userLanguage);

    const answerInstructions = buildAnswerInstructions(
      effectiveMode,
      organisation,
      {
        requestedCount,
        wantsProductUrls,
        compareEntities: answerOptions.compareEntities || null,
        multiEntityMode: answerOptions.multiEntityMode || null,
      },
    );

    const userPrompt = `Context:
---
${context}
---

History:
---
${chatHistory || "No previous conversation"}
---

Question: ${question}

${answerInstructions}`;

    // console.log("checking user prompt : ",userPrompt);

    // console.log("chat history : ",chatHistory);

    // console.log("system prompt : ",systemPrompt);

    try {
      // Determine dynamic max_tokens based on query type
      const dynamicMaxTokens = this.determineMaxTokens(
        question,
        effectiveMode,
        subIntent,
      );

      // Log when dynamic token limit is applied (only if different from default)
      if (dynamicMaxTokens > 200) {
        console.log(
          `[QueryController] Dynamic token limit applied: ${dynamicMaxTokens} tokens for query: "${question.substring(0, 60)}..."`,
        );
      }

      if (chatModel !== briefModel) {
        console.log(
          `[QueryController] Using premium model ${chatModel} (mode=${effectiveMode})`,
        );
      }

      const response = await openai.chat.completions.create({
        model: chatModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature:
          effectiveMode === "list" ||
            effectiveMode === "contact" ||
            effectiveMode === "page_links" ||
            effectiveMode === "compare" ||
            effectiveMode === "recommend"
            ? 0
            : 0.4,
        ...chatCompletionLimitPayload(dynamicMaxTokens, chatModel),
      });

      const answer =
        response.choices[0]?.message?.content?.trim() ||
        "I apologize, I encountered an issue generating a response.";
      const usage = response.usage;

      return { answer, usage, model: chatModel, usageType, source: "llm" };
    } catch (error) {
      console.error("Error generating answer with OpenAI:", error);
      return {
        answer: "I apologize, I encountered an issue generating a response.",
        usage: null,
        model: chatModel,
        usageType,
        source: "llm_error",
      };
    }
  }

  // Context extraction for Qdrant results — always include source URL/title when available
  getRelevantContext(matches, options = {}) {
    // const maxChunkChars = options.maxChunkChars ?? RAG_MAX_CHUNK_CHARS;
    // const maxTotalChars = options.maxTotalChars ?? RAG_MAX_CONTEXT_CHARS;
    const maxChunkChars = 12000;
    const maxTotalChars = 24000;

    // Dedupe by parent_id — child matched, parent returned to LLM
    const byParent = new Map();
    for (const match of matches || []) {
      const payload = match.payload || {};
      const parentId = payload.parent_id;
      const key = parentId
        ? `parent::${parentId}`
        : `${payload.url || ""}::${String(payload.text || "").slice(0, 120)}`;
      const score = match.score ?? 0;
      const prev = byParent.get(key);
      if (!prev || score > (prev.score ?? 0)) {
        byParent.set(key, { match, score });
      }
    }

    const deduped = [...byParent.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((entry) => entry.match);

    let totalChars = 0;
    const blocks = [];

    for (const match of deduped) {
      const payload = match.payload || {};
      let text = stripHtmlForContext(
        payload.parent_text || payload.text || payload.pageContent || "",
      );
      const url = payload.url || "";
      const title = payload.title || url || "";
      if (!text) continue;

      if (text.length > maxChunkChars) {
        text = `${text.slice(0, maxChunkChars)}…`;
      }

      const block = url ? `Source: ${title} (${url})\n---\n${text}\n---` : text;

      if (totalChars + block.length > maxTotalChars) {
        break;
      }

      blocks.push(block);
      totalChars += block.length;
    }

    return blocks.join("\n\n");
  }

  /**
   * Scroll Qdrant for ALL stored chunks belonging to a specific URL.
   * Filters by user_id + agent_id + url for an exact page fetch.
   */
  async fetchAllChunksForUrl(collectionName, url, userId, agentId) {
    const must = [
      { key: "url", match: { value: url } },
      { key: "user_id", match: { value: userId.toString() } },
    ];
    if (agentId) {
      must.push({ key: "agent_id", match: { value: agentId.toString() } });
    }

    const points = [];
    let nextPage = null;

    while (true) {
      const params = {
        limit: 256,
        with_payload: true,
        filter: { must },
        ...(nextPage ? { offset: nextPage } : {}),
      };
      const res = await this.qdrantClient.scroll(collectionName, params);
      points.push(...(res.points || []));
      if (!res.next_page_offset) break;
      nextPage = res.next_page_offset;
    }

    return points;
  }

  /**
   * Deduplicate chunks from multiple training runs and sort by chunk_index.
   * When the same URL was trained multiple times, keeps only the latest run
   * (identified by the group with the most-recent max created_at).
   */
  deduplicateAndSortChunks(points) {
    if (!points || points.length === 0) return [];

    // Group by total_chunks — each unique value likely represents a different training run
    const byTotalChunks = new Map();
    for (const p of points) {
      const tc = p.payload?.total_chunks ?? -1;
      if (!byTotalChunks.has(tc)) byTotalChunks.set(tc, []);
      byTotalChunks.get(tc).push(p);
    }

    // Pick the group whose latest chunk has the most recent created_at
    let bestGroup = points;
    let bestTs = "";
    for (const [, group] of byTotalChunks) {
      const maxTs = group.reduce(
        (best, p) =>
          (p.payload?.created_at || "") > best ? p.payload.created_at : best,
        "",
      );
      if (maxTs > bestTs) {
        bestTs = maxTs;
        bestGroup = group;
      }
    }

    return bestGroup.sort(
      (a, b) => (a.payload?.chunk_index ?? 0) - (b.payload?.chunk_index ?? 0),
    );
  }

  /**
   * Page-merge context builder — only when plan contextMode is "page_merge".
   * Default brief answers use getRelevantContext (top ranked chunks).
   *
   * Flow:
   *  1. Group top-N retrieval matches by URL.
   *  2. Rank URLs by best-chunk score (+ small hit-count bonus).
   *  3. For each ranked URL, scroll Qdrant for ALL its chunks.
   *  4. Deduplicate (latest training run), sort by chunk_index.
   *  5. Drop boilerplate chunks (footer, nav, cookie, link-only).
   *  6. Merge remaining chunks into a single page block.
   *  7. Repeat for next URL until context budget is exhausted.
   */
  async buildPageMergeContext(matches, options = {}) {
    const {
      collectionName,
      userId,
      agentId,
      maxTotalChars = RAG_MAX_CONTEXT_CHARS,
      maxChunkChars = RAG_MAX_CHUNK_CHARS,
      maxUrlsToExpand = 3,
      maxChunksPerUrl = 25,
    } = options;

    // Require Qdrant access params; fall back gracefully
    if (!collectionName || !userId) {
      console.warn(
        "[QueryController] buildPageMergeContext: missing collectionName or userId, falling back to getRelevantContext",
      );
      return this.getRelevantContext(matches, options);
    }

    // --- Step 1 & 2: group by URL and rank ---
    const urlMap = new Map(); // groupKey -> { url, title, maxScore, hitCount }

    for (const match of matches || []) {
      const payload = match.payload || {};
      const url = payload.url || "";
      const title = payload.title || url || "";
      const text = stripHtmlForContext(
        payload.text || payload.pageContent || "",
      );
      const groupKey = url || title;
      if (!groupKey) continue;

      // Exclude boilerplate chunks from URL ranking so footer chunks don't
      // hijack the best-URL selection
      if (isBoilerplateChunk(text)) continue;

      const score = match.score ?? 0;
      if (!urlMap.has(groupKey)) {
        urlMap.set(groupKey, { url, title, maxScore: score, hitCount: 1 });
      } else {
        const entry = urlMap.get(groupKey);
        if (score > entry.maxScore) entry.maxScore = score;
        entry.hitCount += 1;
      }
    }

    // Rank: weighted score + small hit-count bonus (capped)
    const rankedUrls = Array.from(urlMap.values())
      .map((entry) => ({
        ...entry,
        rankScore: entry.maxScore * 0.7 + Math.min(entry.hitCount * 0.05, 0.15),
      }))
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, maxUrlsToExpand);

    if (rankedUrls.length === 0) {
      console.log(
        "[QueryController] buildPageMergeContext: no non-boilerplate URLs found, falling back to getRelevantContext",
      );
      return this.getRelevantContext(matches, options);
    }

    console.log(
      `[QueryController] buildPageMergeContext: expanding ${rankedUrls.length} URL(s) — ` +
      rankedUrls
        .map((u) => `${u.url || u.title} (score=${u.rankScore.toFixed(3)})`)
        .join(", "),
    );

    // --- Steps 3–7: fetch, dedup, filter, merge per URL ---
    const blocks = [];
    let totalChars = 0;

    for (const { url, title } of rankedUrls) {
      if (!url || totalChars >= maxTotalChars) break;

      try {
        const allPoints = await this.fetchAllChunksForUrl(
          collectionName,
          url,
          userId,
          agentId,
        );

        if (allPoints.length === 0) {
          console.log(
            `[QueryController] buildPageMergeContext: no Qdrant points found for ${url}`,
          );
          continue;
        }

        const sorted = this.deduplicateAndSortChunks(allPoints);

        // Filter boilerplate and cap chunk count
        const validChunks = sorted
          .filter(
            (p) =>
              !isBoilerplateChunk(stripHtmlForContext(p.payload?.text || "")),
          )
          .slice(0, maxChunksPerUrl);

        if (validChunks.length === 0) {
          console.log(
            `[QueryController] buildPageMergeContext: all chunks were boilerplate for ${url}`,
          );
          continue;
        }

        const pageText = validChunks
          .map((p) => {
            let t = stripHtmlForContext(p.payload?.text || "");
            if (t.length > maxChunkChars) t = `${t.slice(0, maxChunkChars)}…`;
            return t;
          })
          .join("\n\n");

        const block = `Source: ${title} (${url})\n---\n${pageText}\n---`;

        if (totalChars + block.length > maxTotalChars) {
          const remaining = maxTotalChars - totalChars;
          if (remaining > 300) {
            const overhead = `Source: ${title} (${url})\n---\n\n---`.length;
            const trimmedText = pageText.slice(0, remaining - overhead);
            const trimmedBlock = `Source: ${title} (${url})\n---\n${trimmedText}…\n---`;
            blocks.push(trimmedBlock);
            totalChars += trimmedBlock.length;
          }
          break;
        }

        blocks.push(block);
        totalChars += block.length;
        console.log(
          `[QueryController] buildPageMergeContext: ${url} → ${validChunks.length} chunks merged (${pageText.length} chars)`,
        );
      } catch (err) {
        console.warn(
          `[QueryController] buildPageMergeContext: fetch failed for ${url}: ${err.message}`,
        );
      }
    }

    if (blocks.length === 0) {
      console.log(
        "[QueryController] buildPageMergeContext: expansion yielded no content, falling back to getRelevantContext",
      );
      return this.getRelevantContext(matches, options);
    }

    return blocks.join("\n\n");
  }

  async queryQdrant(
    collectionName,
    queryEmbedding,
    topK,
    userId,
    options = {},
  ) {
    try {
      console.log(
        `[QueryController] Querying Qdrant collection: ${collectionName} with topK: ${topK}, userId: ${userId}`,
      );

      // Check if collection exists and get stats
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections.some(
        (col) => col.name === collectionName,
      );

      if (!collectionExists) {
        console.error(
          `[QueryController] ERROR: Qdrant collection "${collectionName}" does not exist`,
        );
        return [];
      }

      // Get collection info to check point count
      try {
        const collectionInfo =
          await this.qdrantClient.getCollection(collectionName);
        const pointCount = collectionInfo.points_count || 0;
        console.log(
          `[QueryController] Collection "${collectionName}" has ${pointCount} total points`,
        );

        if (pointCount === 0) {
          console.warn(
            `[QueryController] WARNING: Collection is empty! No data has been indexed.`,
          );
          return [];
        }
      } catch (infoError) {
        console.warn(
          `[QueryController] Could not get collection info: ${infoError.message}`,
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

      // First try with user_id filter (tenant isolation). No hard size filters.
      let searchResult = [];

      const buildFilter = () => {
        const must = [];
        if (userId) {
          must.push({
            key: "user_id",
            match: { value: userId.toString() },
          });
        }
        if (options.agentId) {
          must.push({
            key: "agent_id",
            match: { value: options.agentId.toString() },
          });
        }
        // Hard filters are pre-classified by the retrieval policy engine
        // (retrievalPolicy.js) — only high-confidence identity facets
        // (product_id / sku) ever reach here. The size/sizes exclusion is
        // a defense-in-depth guard in case tenant policy is misconfigured.
        for (const hf of options.hardFilters || []) {
          if (!hf?.key || !hf?.value) continue;
          if (hf.key === "size" || hf.key === "sizes") continue;
          must.push({
            key: hf.key === "sku" ? "attributes.sku" : hf.key,
            match: { value: String(hf.value) },
          });
        }
        return must.length > 0 ? { must } : undefined;
      };

      const vectorStore = new QdrantVectorStoreManager(collectionName);
      const queryText = options.queryText || "";
      const lexicalTerms = options.lexicalTerms || [];

      const executeSearch = async (filter) => {
        const mode = await vectorStore.getCollectionVectorMode();
        if (mode === "hybrid") {
          return vectorStore.hybridQuery({
            queryEmbedding,
            queryText,
            lexicalTerms,
            topK,
            filter,
          });
        }
        const searchParams = {
          vector: queryEmbedding,
          limit: topK,
          with_payload: true,
        };
        if (filter) searchParams.filter = filter;
        const results = await this.qdrantClient.search(
          collectionName,
          searchParams,
        );
        return (results || []).map((result) => ({
          id: result.id,
          score: result.score,
          metadata: result.payload || {},
          payload: result.payload || {},
        }));
      };

      if (userId) {
        try {
          searchResult = await executeSearch(buildFilter());
          console.log(
            `[QueryController] Query with tenant filter returned ${searchResult.length} results`,
          );

          // Progressive relax: if hard identity filters yielded nothing, retry tenant-only
          if (
            searchResult.length === 0 &&
            (options.hardFilters || []).length > 0
          ) {
            console.warn(
              `[QueryController] Hard facet filters returned 0 hits — relaxing to tenant filter only`,
            );
            const tenantOnly = [];
            if (userId) {
              tenantOnly.push({
                key: "user_id",
                match: { value: userId.toString() },
              });
            }
            if (options.agentId) {
              tenantOnly.push({
                key: "agent_id",
                match: { value: options.agentId.toString() },
              });
            }
            searchResult = await executeSearch(
              tenantOnly.length ? { must: tenantOnly } : undefined,
            );
          }
        } catch (filterError) {
          console.warn(
            `[QueryController] Error with user_id filter: ${filterError.message}`,
          );
        }
      }

      // If no results with filter, try without filter (fallback for debugging)
      if (searchResult.length === 0 && userId) {
        console.warn(
          `[QueryController] No results with user_id filter. Trying without filter to check if data exists...`,
        );
        try {
          const unfilteredResult = await this.qdrantClient.search(
            collectionName,
            {
              vector: queryEmbedding,
              limit: Math.min(topK * 2, 20), // Get more results to see what's there
              with_payload: true,
            },
          );
          console.log(
            `[QueryController] Query WITHOUT filter returned ${unfilteredResult.length} results. ` +
            `Sample user_ids found: ${unfilteredResult
              .slice(0, 3)
              .map((r) => r.payload?.user_id)
              .filter(Boolean)
              .join(", ")}`,
          );

          // If we found results without filter, it means user_id mismatch
          if (unfilteredResult.length > 0) {
            console.error(
              `[QueryController] CRITICAL: Data exists but user_id filter is excluding all results! ` +
              `Expected user_id: ${userId}, Found user_ids: ${[
                ...new Set(
                  unfilteredResult
                    .map((r) => r.payload?.user_id)
                    .filter(Boolean),
                ),
              ].join(", ")}`,
            );
          }
        } catch (unfilteredError) {
          console.error(
            `[QueryController] Error querying without filter: ${unfilteredError.message}`,
          );
        }
      } else if (!userId) {
        searchResult = await executeSearch(undefined);
        console.log(
          `[QueryController] Query without user_id filter returned ${searchResult.length} results`,
        );
      }

      return (searchResult || []).map((result) => ({
        id: result.id,
        score: result.score,
        metadata: result.payload || result.metadata || {},
        payload: result.payload || result.metadata || {},
      }));
    } catch (error) {
      console.error("[QueryController] Error querying Qdrant:", error);

      // If it's a collection not found error, return empty results
      if (error.message && error.message.includes("not found")) {
        console.error(
          `[QueryController] Collection ${collectionName} not found in Qdrant`,
        );
        return [];
      }

      throw new Error(`Qdrant query failed: ${error.message}`);
    }
  }

  /**
   * Normalize for exact FAQ replay: strip HTML/tags, collapse whitespace, lowercase.
   */
  normalizeExactQuestion(text) {
    return String(text || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * All revised_answer points for this user (scroll; typically a small set).
   */
  async fetchAllRevisedAnswerPayloads(collectionName, userIdString) {
    if (!collectionName || !userIdString) return [];
    try {
      try {
        await this.qdrantClient.createPayloadIndex(collectionName, {
          field_name: "source_type",
          field_schema: "keyword",
        });
      } catch (e) {
        if (!e.message?.includes("already exists")) {
          console.warn(
            `[QueryController] source_type index (revised scroll): ${e.message}`,
          );
        }
      }

      const filter = {
        must: [
          { key: "user_id", match: { value: userIdString.toString() } },
          { key: "source_type", match: { value: "revised_answer" } },
        ],
      };

      const payloads = [];
      let nextPage = null;
      let guard = 0;

      while (guard++ < 200) {
        const params = {
          limit: 128,
          filter,
          with_payload: true,
          ...(nextPage ? { offset: nextPage } : {}),
        };

        const res = await this.qdrantClient.scroll(collectionName, params);
        const batch = res.points || [];
        for (const pt of batch) {
          if (pt.payload) payloads.push(pt.payload);
        }
        if (!res.next_page_offset || batch.length === 0) break;
        nextPage = res.next_page_offset;
      }

      return payloads;
    } catch (error) {
      console.warn(
        `[QueryController] fetchAllRevisedAnswerPayloads: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Applies only when the visitor repeats the exact same question (after normalize).
   */
  async tryReviseAnswerFromQdrant(collectionName, question, userIdString) {
    if (!userIdString || question == null || question === "") return null;

    const target = this.normalizeExactQuestion(question);
    if (!target) return null;

    const payloads = await this.fetchAllRevisedAnswerPayloads(
      collectionName,
      userIdString,
    );

    for (const p of payloads) {
      const orig = this.normalizeExactQuestion(p.original_question);
      if (!orig || orig !== target) continue;

      const text = String(p.text || "").trim();
      if (!text) continue;

      console.log(
        "[QueryController] Revised answer: exact (normalized) question match",
      );

      return {
        answer: text,
        sources: [
          {
            type: 4,
            title: p.title || "Revised Answer",
            url: null,
          },
        ],
      };
    }

    return null;
  }

  // check 1 -->

  async getAnswer(userId, agentId, question, conversationId, options = {}) {
    // Default threshold: 0.4 is reasonable for cosine similarity
    // Lower thresholds (0.2-0.3) may include irrelevant results
    // Higher thresholds (0.5-0.7) may be too strict and miss relevant results
    const { topK = 10, scoreThreshold = 0.4 } = options;
    // Coerce to a safe numeric value so downstream logic is consistent
    const requestedTopK = Math.max(1, Number(topK) || 5);

    try {
      // 1. Get Chat History
      const chatSession = await this.getChatHistory(conversationId);
      const ragState = await loadRagState(conversationId);
      const stateTopics = topicsFromRagState(ragState);
      const getChatHistoryFormatted = (historyLimit = CHAT_HISTORY_LIMIT) =>
        this.formatChatHistory(chatSession, question, { historyLimit });

      // 3. Get Client, Widget, and WebsiteData
      const clientData = await Client.findOne({ userId }).lean();
      const agentData = await Agent.findOne({ _id: agentId }).lean();
      const widgetData = await Widget.findOne({ agentId }).lean();
      const websiteData = await WebsiteData.findOne({ agentId }).lean();
      const companyName = this.resolveCompanyName({
        websiteData,
        widgetData,
        agentData,
      });


      if (
        !clientData ||
        !agentData.qdrantIndexName ||
        !agentData.qdrantIndexNamePaid
      ) {
        throw new Error(
          `Qdrant collection not configured for agent ${agentId}`,
        );
      }
      if (!widgetData) {
        throw new Error(`Widget data not found for agent ${agentId}`);
      }

      // Use the same field name for compatibility, but it represents Qdrant collection now

      const collectionName =
        clientData?.plan == "free"
          ? agentData?.qdrantIndexName
          : agentData?.qdrantIndexNamePaid;

      const userIdString = userId?.toString();

      // Revised answers only on normalized exact duplicate of the visitor question (no embeddings).
      const revisedFromKb = await this.tryReviseAnswerFromQdrant(
        collectionName,
        question,
        userIdString,
      );

      console.log("revised from kb response : ", revisedFromKb);
      if (revisedFromKb) {
        return {
          success: true,
          answer: revisedFromKb.answer,
          sources:
            revisedFromKb.sources?.length > 0
              ? revisedFromKb.sources
              : undefined,
          conversationId,
          isAgentRequest: false,
        };
      }

      const websiteLanguage = websiteData?.primary_language || "en";

      // --- Light normalization ---
      const queryNorm = normalizeUserQuery(question);
      const normalizedQuestion = queryNorm.normalized;

      if (normalizedQuestion !== question.trim()) {
        console.log(
          `[QueryController] Normalized query: "${question.trim()}" → "${normalizedQuestion}"`,
        );
      }

      // Intent classification FIRST (rules → LLM) + multi-entity mode enrichment
      const baseRouting = await routeQuery(normalizedQuestion, {
        chatMessages: chatSession,
        conversationState: ragState,
        websiteLanguage,
        openaiClient: openai,
        logOpenAIUsage: ({ usage, modelName, type }) =>
          this.logOpenAIChatUsage({
            userId,
            agentId,
            conversationId,
            usage,
            modelName,
            type: type || "intent",
          }),
      });
      let routing = enrichRoutingMultiEntity(baseRouting, normalizedQuestion);

      // Temporary override: contact-detail requests should use the standard
      // semantic RAG path instead of contact-mode retrieval/formatting.
      if (routing.subIntent === "CONTACT_INFO") {
        routing = {
          ...routing,
          route: ROUTES.SEMANTIC_RAG,
          subIntent: null,
          source: "contact_to_semantic_override",
        };
      }

      // Temporary override: acknowledgements should continue through semantic
      // retrieval instead of returning the acknowledgement-only response.
      if (routing.route === ROUTES.ACKNOWLEDGEMENT) {
        routing = {
          ...routing,
          route: ROUTES.SEMANTIC_RAG,
          subIntent: null,
          source: "ack_to_semantic_override",
        };
      }

      // Defense in depth: identity requests must reach the company-profile/RAG
      // answer path even if an upstream model returns a social route.
      const isIdentityRequest =
        Boolean(routing.isIdentityQuestion) ||
        this.isCompanyIdentityQuestion(normalizedQuestion, companyName);
      if (
        isIdentityRequest &&
        (routing.route !== ROUTES.SEMANTIC_RAG || !routing.rewrittenQuery)
      ) {
        if (routing.route !== ROUTES.SEMANTIC_RAG) {
          console.warn(
            `[QueryController] Correcting identity route ${routing.route} → ${ROUTES.SEMANTIC_RAG}`,
          );
        }
        routing = {
          ...routing,
          route: ROUTES.SEMANTIC_RAG,
          subIntent: null,
          rewrittenQuery:
            routing.rewrittenQuery ||
            `${companyName || "Company"} overview, products, services, and customer support assistant role`,
          needsRewrite: true,
          rewriteReason: routing.rewriteReason || "NORMALIZE",
          isIdentityQuestion: true,
          isBusinessQuestion: true,
          isTrulyOffTopic: false,
          source:
            routing.route === ROUTES.SEMANTIC_RAG
              ? routing.source
              : "identity_safety_override",
        };
      }

      console.log(
        `[QueryController] Route: ${routing.route} | subIntent: ${routing.subIntent} | multiEntity: ${routing.multiEntityMode || "none"} | rawEntities: [${(routing.rawEntities || []).join(", ")}] | userLang: ${routing.userLanguage} | confidence: ${routing.confidence} | followUp: ${routing.followUp} | needsRewrite: ${routing.needsRewrite} | rewriteReason: ${routing.rewriteReason || "none"} | lexicalTerms: [${(routing.lexicalTerms || []).join(", ")}] | constraints: [${(routing.constraints || []).map((c) => `${c.field}${c.operator === "eq" ? "=" : ":" + c.operator + ":"}${c.value}@${c.confidence}`).join(", ")}] | source: ${routing.source}`,
      );

      const langOpts = { userLanguage: routing.userLanguage };

      if (routing.route === ROUTES.GREETING) {

        return await this.respondToGreeting({
          question,
          companyName,
          routing,
          websiteLanguage,
          options,
          conversationId,
          userId,
          agentId,
        }).then(async (result) => {
          await this.persistRagStateForTurn(conversationId, {
            routing,
            ragState,
            clear: true,
          });
          return result;
        });
      }

      if (routing.route === ROUTES.ACCIDENTAL && USE_LIGHTWEIGHT_RESPONSES) {
        return await this.respondToAccidental({
          question,
          companyName,
          routing,
          websiteLanguage,
          options,
          conversationId,
          userId,
          agentId,
        }).then(async (result) => {
          await this.persistRagStateForTurn(conversationId, {
            routing,
            ragState,
            clear: true,
          });
          return result;
        });
      }

      if (routing.route === ROUTES.LIVE_AGENT && USE_LIGHTWEIGHT_RESPONSES) {
        return await this.respondToLiveAgent({
          question,
          companyName,
          routing,
          websiteLanguage,
          options,
          conversationId,
          userId,
          agentId,
        }).then(async (result) => {
          await this.persistRagStateForTurn(conversationId, {
            routing,
            ragState,
            clear: true,
          });
          return result;
        });
      }

      if (routing.route === ROUTES.ACKNOWLEDGEMENT) {
        const templateResult = buildAcknowledgementResponse({
          companyName,
          userLanguage: routing.userLanguage,
        });

        if (templateResult) {
          console.log(
            `[QueryController] Acknowledgement template (${routing.userLanguage}) — skipping retrieval`,
          );
          await this.persistRagStateForTurn(conversationId, {
            routing,
            ragState,
          });
          return {
            success: true,
            answer: templateResult.answer,
            conversationId,
            isAgentRequest: false,
          };
        }

        // No template for this language — cheap LLM, no context, no history
        console.log(
          `[QueryController] Acknowledgement LLM fallback (${routing.userLanguage}) — skipping retrieval`,
        );
        const ackResult = await this.generateAnswer(
          question,
          `The user sent a short acknowledgement in their language. Reply warmly in the same language and invite them to ask more questions about ${companyName}. Keep it brief, but follow the required HTML response structure.`,
          [],
          companyName,
          websiteData,
          { ...langOpts, forcePremium: false },
        );
        this.logAnswerUsage(userId, agentId, ackResult, conversationId);
        await this.persistRagStateForTurn(conversationId, {
          routing,
          ragState,
        });
        return {
          success: true,
          answer: ackResult.answer,
          conversationId,
          isAgentRequest: false,
        };
      }


      console.log("routing data check: ", routing);

      // --- Light heuristic expansion (sizes / collections from conversation state) ---
      const queryExpansion = expandQueryForRetrieval(
        normalizedQuestion,
        chatSession,
        { sizes: queryNorm.sizes, stateTopics },
      );

      console.log("query expansion check :", queryExpansion);
      const { retrievalQuery, currentSizes } = queryExpansion;
      const queryWasEnriched =
        retrievalQuery.trim() !== normalizedQuestion.trim();

      if (queryWasEnriched) {
        console.log(
          `[QueryController] Expanded retrieval query: "${retrievalQuery}"`,
        );
      }

      // --- Pronoun rewrite + optional HyDE (modular; see services/retrieval/) ---
      // Produces:
      //   lexicalQuery   → sparse / keyword / hybrid queryText (standalone rewrite)
      //   embeddingQuery → dense vector input (may include HyDE hypothetical snippet)
      const preparedQuery = await prepareRetrievalQuery({
        normalizedQuestion,
        retrievalQuery,
        chatHistory: chatSession,
        routing,
        openaiClient: openai,
        logOpenAIUsage: ({ usage, modelName, type }) =>
          this.logOpenAIChatUsage({
            userId,
            agentId,
            conversationId,
            usage,
            modelName,
            type: type || "intent",
          }),
      });

      const lexicalQuery = preparedQuery.lexicalQuery;
      // Morphology / brand enrichment for embedding (keeps HyDE text intact when present)
      const baseForEmbedding = preparedQuery.embeddingQuery;
      const embeddingQuery = preparedQuery.hydeText
        ? baseForEmbedding
        : queryNorm.enrichForEmbedding(baseForEmbedding);

      if (preparedQuery.wasResolved) {
        console.log(
          `[QueryController] Query rewrite (${preparedQuery.rewriteSource}): "${preparedQuery.baseQuery}" → "${lexicalQuery}"`,
        );
      }
      if (preparedQuery.hydeText) {
        console.log(
          `[QueryController] HyDE active — dense embed uses expanded query (${embeddingQuery.length} chars)`,
        );
      } else if (routing.rewrittenQuery) {
        console.log(
          `[QueryController] Translated embedding query (${routing.userLanguage} → ${websiteLanguage}): "${baseForEmbedding}"`,
        );
      } else if (embeddingQuery !== retrievalQuery) {
        console.log(
          `[QueryController] Enriched embedding query: "${embeddingQuery}"`,
        );
      }

      const subIntent = routing.subIntent || null;

      // Prefer rewritten lexical query for keyword / attribute extraction so
      // follow-ups like "price?" carry the resolved product terms into rerank.
      const queryAttributes = extractQueryAttributes({
        normalizedQuestion,
        queryNorm,
        queryExpansion: {
          ...queryExpansion,
          retrievalQuery: lexicalQuery,
        },
        routing: {
          ...routing,
          // prepareRetrievalQuery already started from rewrittenQuery || retrievalQuery
          rewrittenQuery: lexicalQuery,
        },
        subIntent,
      });

      console.log("query attribute check : ", queryAttributes);

      const retrievalPlan = buildRetrievalPlan({
        routing,
        queryAttributes,
        requestedTopK,
      });

      console.log("retrivel plan check :", retrievalPlan);
      logRetrievalPlan(retrievalPlan);

      console.log(
        `[QueryController] Attributes: subIntent=${subIntent || "none"} sizes=[${queryAttributes.sizes.join(", ")}] collections=[${queryAttributes.collections.join(", ")}] keywords=${queryAttributes.keywords.length}`,
      );

      const catalogKeywords =
        queryAttributes.keywords.length > 0
          ? queryAttributes.keywords
          : this.buildCatalogKeywords(queryAttributes.keywordSource, {
            ...queryNorm,
            sizes: queryNorm.sizes?.length
              ? queryNorm.sizes
              : currentSizes || [],
          });

      console.log("catalog keywords check : ", catalogKeywords);

      let questionEmbedding = null;
      const getQuestionEmbedding = async () => {
        if (!questionEmbedding) {
          const embeddingModel = await this.getEmbeddingModel();
          const embeddingResponse = await embeddingModel.embedQuery(embeddingQuery);
          if (!embeddingResponse) {
            throw new Error("Failed to generate question embedding.");
          }
          // LangChain embedQuery returns a number[]; some wrappers may return { embedding, usage }
          questionEmbedding = embeddingResponse.embedding || embeddingResponse;

          // Always log embedding usage. LangChain does not expose token usage on embedQuery,
          // so fall back to a char/4 estimate (same approach as ReviseAnswer).
          try {
            const usage = embeddingResponse.usage;
            let inputTokens = 0;
            if (usage) {
              inputTokens =
                usage.prompt_tokens ||
                usage.input_tokens ||
                usage.total_tokens ||
                0;
            }
            if (!inputTokens) {
              const text =
                typeof embeddingQuery === "string"
                  ? embeddingQuery
                  : String(embeddingQuery || "");
              inputTokens = text.length > 0 ? Math.ceil(text.length / 4) : 0;
            }

            if (inputTokens > 0) {
              const modelRecord = await getResolvedModelConfig("embedding").catch(
                () => null
              );
              const embeddingModelName =
                embeddingResponse.model ||
                modelRecord?.model ||
                this.currentModelName ||
                "text-embedding-3-small";
              const costs = computeTokenCosts({
                inputTokens,
                outputTokens: 0,
                cacheTokens: 0,
                inputCostPerMillion: modelRecord?.inputCost || 0,
                outputCostPerMillion: 0,
                cacheCostPerMillion: 0,
              });

              logOpenAIUsage({
                userId,
                agentId,
                conversationId,
                model: embeddingModelName,
                type: "embedding",
                inputTokens,
                outputTokens: 0,
                cacheTokens: 0,
                totalTokens: inputTokens,
                ...costs,
              }).catch((logErr) => {
                console.warn(
                  `[QueryController] Error logging embedding usage: ${logErr.message}`
                );
              });
            }
          } catch (logError) {
            console.warn(
              `[QueryController] Error logging embedding usage: ${logError.message}`
            );
          }
        }
        return questionEmbedding;
      };

      // Prefer plan candidate depth (50–80); do not shrink below plan for RRF+rerank
      let semanticTopK =
        retrievalPlan.retrievalPolicy.semanticTopK ||
        Math.max(60, requestedTopK * 3);

      console.log("check semantic topK:", semanticTopK);

      // --- Multi-entity pipeline: resolve → plan → per-entity hybrid → interleave ---
      let queryResponse = [];
      let multiEntityMeta = null;
      let entityResolution = null;
      let multiEntityPlan = null;

      entityResolution = resolveEntities({
        multiEntityMode: routing.multiEntityMode,
        rawEntities: routing.rawEntities,
        query: lexicalQuery,
        chatHistory: chatSession,
        ragState,
        lastMatches: [],
      });
      
      console.log("before entity resolution check its routing : ",routing);

      console.log("entity resolution check : ",entityResolution);

      if (entityResolution.shouldUseMultiRetrieval) {
        multiEntityPlan = buildMultiEntityRetrievalPlan({
          multiEntityMode: entityResolution.multiEntityMode,
          entities: entityResolution.entities,
          baseRetrievalPlan: retrievalPlan,
        });
      }

      console.log("entity resolution:", entityResolution);
      console.log("multi entity plan:", multiEntityPlan);

      if (multiEntityPlan) {
        console.log(
          `[QueryController] Multi-entity branch (${entityResolution.source}): ` +
            entityResolution.entities.join(" | "),
        );

        const perEntitySemanticTopK =
          multiEntityPlan.policy.semanticTopK ||
          Math.min(40, semanticTopK);

        multiEntityMeta = await runMultiEntityRetrieval({
          entityPlans: multiEntityPlan.entities,
          isComparison:
            entityResolution.multiEntityMode === MULTI_ENTITY_MODES.COMPARE,
          multiEntityMode: entityResolution.multiEntityMode,
          topKPerEntity: multiEntityPlan.policy.topKPerEntity,
          maxTotalMatches: multiEntityPlan.policy.maxTotalMatches,
          /**
           * Full retrieval per entity plan:
           * embed(denseQuery) → hybrid → attribute rerank → topK slice inside orchestrator.
           */
          runEntityRetrieval: async (plan) => {
            const embeddingModel = await this.getEmbeddingModel();
            const entityEmbedding = await embeddingModel.embedQuery(
              plan.denseQuery,
            );

            return this.runHybridRetrieval({
              collectionName,
              userIdString,
              semanticTopK: perEntitySemanticTopK,
              catalogKeywords: plan.lexicalKeywords,
              getQuestionEmbedding: async () => entityEmbedding,
              queryAttributes: {
                ...queryAttributes,
                keywords: plan.lexicalKeywords,
                retrievalQuery: plan.sparseQuery,
                keywordSource: plan.name,
              },
              queryText: plan.sparseQuery,
              agentId,
              plan: {
                ...retrievalPlan,
                retrievalPolicy: multiEntityPlan.policy,
              },
            });
          },
        });

        queryResponse = multiEntityMeta.matches || [];

        if (retrievalPlan?.retrievalPolicy) {
          Object.assign(retrievalPlan.retrievalPolicy, multiEntityPlan.policy);
          retrievalPlan.retrievalPolicy.finalTopK = Math.max(
            retrievalPlan.retrievalPolicy.finalTopK || 12,
            queryResponse.length,
          );
        }
      } else {
        // Single-entity: standard hybrid retrieval
        queryResponse = await this.runHybridRetrieval({
          collectionName,
          userIdString,
          semanticTopK,
          catalogKeywords,
          getQuestionEmbedding,
          queryAttributes,
          queryText: lexicalQuery,
          agentId,
          plan: retrievalPlan,
        });
      }

      console.log("subIntent : ", subIntent);

      // Standard semantic RAG path (always runs; specialized path only when quality passes)

      // Log if no results found at all
      if (queryResponse.length === 0) {
        console.warn(
          `[QueryController] WARNING: No results found in collection "${collectionName}" for user "${userIdString}". This could mean:\n` +
          `  1. Collection is empty or has no data for this user\n` +
          `  2. Data hasn't been indexed yet\n` +
          `  3. Collection name is incorrect\n` +
          `  4. agent_id filter is too restrictive`,
        );
      }

      // Rank-based selection after multi-signal rerank (no absolute RRF threshold)
      const catalogListQuery =
        retrievalPlan.retrievalPolicy.contextMode === "list";

      let relevantMatches = selectMatchesByPlan(queryResponse, retrievalPlan, {
        relaxed: false,
      });

      if (catalogListQuery && relevantMatches.length > 0) {
        console.log(
          `[QueryController] List context: using ${relevantMatches.length} RRF+reranked chunks (rank-based, no score gate)`,
        );
      }

      const maxScore =
        queryResponse.length > 0
          ? Math.max(...queryResponse.map((m) => m.score ?? 0))
          : 0;

      // Absolute RRF/cosine thresholds are unreliable after fusion+rerank.
      // Only treat as empty/irrelevant when retrieval returned nothing.
      const isIrrelevant = queryResponse.length === 0;

      if (isIrrelevant) {
        console.warn(
          `[QueryController] No retrieval candidates for: "${question.substring(0, 50)}..."`,
        );
      }

      // If too few after cut, expand final window slightly (still rank-based)
      if (
        !isIrrelevant &&
        relevantMatches.length <
        (retrievalPlan.retrievalPolicy.minResults || 5) &&
        retrievalPlan.retrievalPolicy.allowRelax
      ) {
        relevantMatches = selectMatchesByPlan(queryResponse, retrievalPlan, {
          relaxed: true,
        });
        if (relevantMatches.length > 0) {
          console.warn(
            `[QueryController] Progressive expand: using ${relevantMatches.length} rank-ordered matches`,
          );
        }
      }

      if (
        !isIrrelevant &&
        queryResponse.length > 0 &&
        relevantMatches.length <
        (retrievalPlan.retrievalPolicy.minResults || requestedTopK)
      ) {
        const needed =
          (retrievalPlan.retrievalPolicy.finalTopK || requestedTopK) -
          relevantMatches.length;
        const supplemental = [...queryResponse]
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .filter((m) => !relevantMatches.find((r) => r.id === m.id))
          .slice(0, Math.max(0, needed));

        if (supplemental.length > 0) {
          console.warn(
            `[QueryController] Filling ${supplemental.length} top remaining matches to reach plan finalTopK`,
          );
          relevantMatches = [...relevantMatches, ...supplemental];
        }
      }



      let finalAnswer;
      // Chunks actually used for generation — sources are derived from these only.
      let contextMatchesForSources = [];

      if (relevantMatches.length === 0 && queryResponse.length > 0) {

        console.log("check 1 : ",)
        const onTopicResult = await this.answerOnTopicWithFallback({
          question,
          relevantMatches,
          queryResponse,
          requestedTopK,
          getChatHistoryFormatted,
          companyName,
          websiteData,
          langOpts,
          wasExpanded: queryWasEnriched,
          maxScore,
          userId,
          agentId,
          conversationId,
        });
        finalAnswer = onTopicResult.answer;
        contextMatchesForSources = onTopicResult.matches || [];
      } else if (queryResponse.length === 0 || isIrrelevant) {

        console.log("check 2 : ",)
        const useLightTemplate = USE_LIGHTWEIGHT_RESPONSES && isIrrelevant;

        if (useLightTemplate) {
          const offTopicResult = await this.respondToOffTopic({
            question,
            companyName,
            routing,
            websiteLanguage,
            options,
            conversationId,
            isIrrelevant,
            userId,
            agentId,
          });
          finalAnswer = offTopicResult.answer;
          contextMatchesForSources = [];
        } else {

          console.log("check 3 : ");
          const contextMessage = `The user asked: "${question}". No matching knowledge-base content was found for ${companyName}. Redirect politely and offer help with relevant topics.`;

          const offTopicHistory = getChatHistoryFormatted(
            CHAT_HISTORY_LIMIT_BRIEF,
          );
          const offTopicResult = await this.generateAnswer(
            question,
            contextMessage,
            offTopicHistory,
            companyName,
            websiteData,
            { ...langOpts, forcePremium: false },
          );
          finalAnswer = offTopicResult.answer;
          contextMatchesForSources = [];
          this.logAnswerUsage(userId, agentId, offTopicResult, conversationId);
        }
      } else {

        let historyLimit = 10;

        // Multi-entity / comparison / choose-from-list: larger context + mode-aware answer.
        const isMultiEntityTurn = Boolean(
          multiEntityMeta && (multiEntityMeta.matches || []).length > 0,
        );

        console.log("is multi entity turn check : ", isMultiEntityTurn);

        let responseMode = "brief";
        if (isMultiEntityTurn) {
          responseMode =
            entityResolution?.multiEntityMode === MULTI_ENTITY_MODES.COMPARE
              ? "compare"
              : "recommend";
        } else if (retrievalPlan.retrievalPolicy.contextMode === "list") {
          responseMode = "list";
        } else if (retrievalPlan.retrievalPolicy.contextMode === "contact") {
          responseMode = "contact";
        } else if (retrievalPlan.retrievalPolicy.contextMode === "links") {
          responseMode = "page_links";
        } else if (retrievalPlan.retrievalPolicy.contextMode === "page_merge") {
          responseMode = "brief";
        }

        console.log("updated response mode check : ", responseMode);

        let requestedCount =
          responseMode === "list"
            ? this.extractRequestedCount(question, requestedTopK)
            : responseMode === "recommend"
              ? this.extractRequestedCount(
                  question,
                  Math.max(5, entityResolution?.entities?.length || 0),
                )
              : responseMode === "compare"
                ? entityResolution?.entities?.length || 2
                : 1;

        const answerResult = await this.generateAnswerFromMatches({
          question,
          matches: relevantMatches,
          chatHistory: getChatHistoryFormatted(historyLimit),
          organisation: companyName,
          websiteData,
          answerOptions: {
            responseMode,
            contextMode: isMultiEntityTurn
              ? "compare"
              : retrievalPlan.retrievalPolicy.contextMode,
            requestedCount,
            wantsProductUrls: false,
            wasExpanded: queryWasEnriched,
            retrievalMaxScore: maxScore,
            subIntent: isMultiEntityTurn
              ? entityResolution?.multiEntityMode ===
                MULTI_ENTITY_MODES.COMPARE
                ? "COMPARE"
                : null
              : subIntent || null,
            collectionName,
            userId: userIdString,
            agentId: agentId?.toString(),
            maxTotalChars: isMultiEntityTurn
              ? multiEntityMeta.maxContextChars
              : retrievalPlan.retrievalPolicy.tokenBudget,
            prebuiltContext: isMultiEntityTurn
              ? multiEntityMeta.prebuiltContext
              : undefined,
            compareEntities: isMultiEntityTurn
              ? entityResolution?.entities
              : undefined,
            multiEntityMode: isMultiEntityTurn
              ? entityResolution?.multiEntityMode
              : undefined,
            forcePremium: isMultiEntityTurn,
            ...langOpts,
          },
        });
        finalAnswer = answerResult.answer;
        contextMatchesForSources = relevantMatches;
        this.logAnswerUsage(userId, agentId, answerResult, conversationId);
      }

      // 10. Sources = top unique pages from chunks used for generation (not full retrieval).
      // Persist lightweight conversation state for query rewrite/retrieval in future turns.
      const isOffTopicForState =
        (Array.isArray(relevantMatches) && relevantMatches.length === 0) ||
        Boolean(isIrrelevant);
      await this.persistRagStateForTurn(conversationId, {
        routing,
        ragState,
        // Persist the rewritten standalone query so future follow-ups keep entity context.
        retrievalQuery: lexicalQuery,
        baseForEmbedding,
        queryAttributes,
        matches: contextMatchesForSources,
        isOffTopic: isOffTopicForState,
        assistantAnswer: finalAnswer,
      });
      const sources = this.matchesToSources(contextMatchesForSources);

      return {
        success: true,
        answer: finalAnswer,
        sources: sources.length > 0 ? sources : undefined,
        conversationId,
        isAgentRequest: false,
      };
    } catch (error) {
      console.error(
        `Error in getAnswer for ConvID ${conversationId}, User ${userId}:`,
        error,
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
  agentId,
  question,
  conversationId,
  options = {},
) {
  try {
    if (!userId || !agentId || !question || !conversationId) {
      return {
        success: false,
        error: "userId, agentId, question, and conversationId are required.",
      };
    }

    const qa = new QuestionAnsweringSystem();
    const result = await qa.getAnswer(
      userId,
      agentId,
      question,
      conversationId,
      options,
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