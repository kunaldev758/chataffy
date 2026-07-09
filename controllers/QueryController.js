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
const { logOpenAIUsage } = require("../services/UsageTrackingService");
const {
  routeQuery,
  ROUTES,
  isLiveAgentRequest,
  isPureGreeting,
} = require("../services/QueryRouter");
const {
  buildGreetingResponse,
  buildLiveAgentResponse,
  buildAccidentalResponse,
  buildOffTopicResponse,
  isGibberishOrAccidentalMessage,
} = require("../services/LightweightResponseService");
const { generateContactResponse } = require("../services/LlamaContactService");
const { generateGreeting } = require("../services/LlamaGreetingService");
const {
  expandQueryForRetrieval,
  isProductLinkRequest,
  isEcommerceCatalogQuery,
} = require("../utils/queryContextExpansion");
const {
  normalizeUserQuery,
  buildRetrievalKeywords,
} = require("../utils/queryNormalization");
const {
  extractQueryAttributes,
  needsKeywordRetrieval,
  isExplicitSizedCatalogQuery,
} = require("../utils/queryAttributes");
const {
  rerankByAttributes,
  logRerankStats,
  filterMatchesBySizes,
} = require("../utils/attributeReranker");
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

// --- Configuration ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Define models used in this service
const EMBEDDING_MODEL =
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
  Number(process.env.RAG_MAX_CHUNK_CHARS_BRIEF) || 1000;
const RAG_MAX_CONTEXT_CHARS = Number(process.env.RAG_MAX_CONTEXT_CHARS) || 6000;
const RAG_MAX_CONTEXT_CHARS_BRIEF =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_BRIEF) || 4000;
const RAG_MAX_CONTEXT_CHARS_LIST =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_LIST) || 12000;
const RAG_MAX_CONTEXT_CHARS_LINKS =
  Number(process.env.RAG_MAX_CONTEXT_CHARS_LINKS) || 3000;
const RAG_MAX_CHUNK_CHARS_LIST =
  Number(process.env.RAG_MAX_CHUNK_CHARS_LIST) || 800;
const RAG_LIST_MAX_URLS = Number(process.env.RAG_LIST_MAX_URLS) || 30;
const RAG_KEYWORD_FETCH_MAX = Number(process.env.RAG_KEYWORD_FETCH_MAX) || 120;
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
  if (t.includes("got some questions?") && t.includes("here for you")) return true;
  if (t.includes("privacy policy") && t.includes("terms and conditions") && text.length < 400) return true;
  if (t.includes("best price guaranteed") && t.includes("our website")) return true;

  // Cookie / newsletter banners
  if (t.includes("we use cookies") || t.includes("subscribe to our newsletter")) return true;

  // Link-heavy chunks (≥4 URLs, few real words)
  const linkCount = (text.match(/https?:\/\//g) || []).length;
  const wordCount = text.trim().split(/\s+/).length;
  if (linkCount >= 4 && wordCount < 25) return true;

  // Heading-only chunks — single # line, no body text
  const trimmed = text.trim();
  if (/^#{1,4}\s+\S/.test(trimmed) && trimmed.split("\n").length <= 2 && trimmed.length < 100) return true;

  return false;
}

function keywordFetchLimit(requestedCount, perItemMultiplier, floor) {
  const raw = Math.max(floor, (Number(requestedCount) || 5) * perItemMultiplier);
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
    if (curProduct !== bestProduct) return curProduct > bestProduct ? cur : best;

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
    responseMode === "page_links"
  );
}

function selectChatModel({
  responseMode = "brief",
  retrievalMaxScore,
  wasExpanded = false,
  forcePremium = false,
}) {
  if (forcePremium || isPremiumResponseMode(responseMode)) {
    return CHAT_MODEL_PREMIUM;
  }
  if (wasExpanded) {
    return CHAT_MODEL_PREMIUM;
  }
  if (
    retrievalMaxScore !== undefined &&
    retrievalMaxScore !== null &&
    retrievalMaxScore < LOW_RETRIEVAL_SCORE_PREMIUM
  ) {
    return CHAT_MODEL_PREMIUM;
  }
  return CHAT_MODEL_BRIEF;
}

function getContextLimitsForMode(responseMode) {
  if (responseMode === "page_links") {
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
  if (isPremiumResponseMode(responseMode)) {
    return {
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      maxTotalChars: RAG_MAX_CONTEXT_CHARS,
    };
  }
  return {
    maxChunkChars: RAG_MAX_CHUNK_CHARS_BRIEF,
    maxTotalChars: RAG_MAX_CONTEXT_CHARS_BRIEF,
  };
}

// --- Initialize Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
  url:
    process.env.QDRANT_URL ||
    "https://8659fcda-ff81-4896-8786-55418a544b55.eu-central-1-0.aws.cloud.qdrant.io",
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
        .sort({ createdAt: 1 }) // Oldest first to maintain conversation flow
        .limit(CHAT_HISTORY_LIMIT)
        .lean();

      return messages.reverse() || [];
    } catch (error) {
      console.error("Error getting chat history:", error);
      // Return empty array on error to allow processing to continue if possible
      return [];
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
  }) {
    const { answer, language, source } = await generateGreeting({
      companyName,
      userMessage: question,
      userLanguage: routing.userLanguage,
      websiteLanguage,
      visitorLocale: options.visitorLocale,
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

  respondToAccidental({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
  }) {
    const { answer } = buildAccidentalResponse(
      this.buildLightweightResponseContext({
        companyName,
        userMessage: question,
        routing,
        websiteLanguage,
        options,
      }),
    );

    console.log(
      `[QueryController] Accidental response (${routing.userLanguage})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: false,
    };
  }

  respondToLiveAgent({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
  }) {
    const { answer } = buildLiveAgentResponse(
      this.buildLightweightResponseContext({
        companyName,
        userMessage: question,
        routing,
        websiteLanguage,
        options,
      }),
    );

    console.log(
      `[QueryController] Live-agent response (${routing.userLanguage})`,
    );

    return {
      success: true,
      answer,
      conversationId,
      isAgentRequest: true,
    };
  }

  respondToOffTopic({
    question,
    companyName,
    routing,
    websiteLanguage,
    options,
    conversationId,
    isIrrelevant = false,
  }) {
    const { answer, source } = buildOffTopicResponse({
      companyName,
      userMessage: question,
      routingUserLanguage: routing?.userLanguage,
      visitorLocale: options?.visitorLocale,
      websiteLanguage,
      isIrrelevant,
    });

    console.log(
      `[QueryController] Off-topic response via ${source} (${routing?.userLanguage || "en"})`,
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

    if (type) parts.push(`Company type: ${type}`);
    if (industry) parts.push(`Industry: ${industry}`);
    if (founded) parts.push(`Founded: ${founded}`);
    if (valueProp) parts.push(`Value proposition: ${valueProp}`);
    if (services.length > 0) {
      parts.push(
        `Services/products:\n${services.map((s) => `- ${s}`).join("\n")}`,
      );
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
      this.logAnswerUsage(userId, agentId, result);
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
    this.logAnswerUsage(userId, agentId, result);
    return { answer: result.answer, matches: [] };
  }

  logAnswerUsage(userId, agentId, { usage, model } = {}) {
    if (!usage) return;
    logOpenAIUsage({
      userId,
      agentId,
      tokens: usage.total_tokens,
      requests: 1,
      model: model || CHAT_MODEL_BRIEF,
    });
  }

  async generateAnswerFromMatches({
    question,
    matches,
    chatHistory,
    organisation,
    websiteData,
    answerOptions = {},
  }) {
    const {
      responseMode = "brief",
      requestedCount = 5,
      wantsProductUrls = false,
    } = answerOptions;

    const effectiveMode =
      wantsProductUrls && responseMode === "brief" ? "list" : responseMode;

    if (effectiveMode === "contact" && USE_LIGHTWEIGHT_RESPONSES) {
      const contactResult = await generateContactResponse({
        companyName: organisation,
        userMessage: question,
        userLanguage: answerOptions.userLanguage,
        matches,
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

    const contextLimits = getContextLimitsForMode(effectiveMode);
    let context;

    if (answerOptions.prebuiltContext) {
      context = answerOptions.prebuiltContext;
    } else if (effectiveMode === "page_links") {
      context = this.buildCompactPageLinksContext(matches, {
        ...contextLimits,
        requestedCount,
      });
    } else if (effectiveMode === "list") {
      context = this.buildInPageListContext(matches, {
        ...contextLimits,
        requestedCount,
      });
    } else {
      // "brief" and "contact" modes: use page-merge context builder.
      // Falls back to getRelevantContext automatically when collectionName/userId are absent.
      context = await this.buildPageMergeContext(matches, {
        ...contextLimits,
        collectionName: answerOptions.collectionName,
        userId:         answerOptions.userId,
        agentId:        answerOptions.agentId,
      });
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
  determineMaxTokens(question, responseMode = "brief") {
    if (responseMode === "list") {
      const count = this.extractRequestedCount(question, 5);
      return Math.min(2000, 300 + count * 120);
    }
    if (responseMode === "contact") {
      return 800;
    }
    if (responseMode === "page_links") {
      const count = this.extractRequestedCount(question, 5);
      return Math.min(1200, 200 + count * 100);
    }

    const normalizedQuestion = question.toLowerCase().trim();

    // Keywords that indicate queries requiring longer responses
    const longResponseKeywords = [
      "list",
      "top",
      "best",
      "all",
      "multiple",
      "several",
      "many",
      "links",
      "link",
      "url",
      "urls",
      "products",
      "items",
      "options",
      "ways",
      "steps",
      "examples",
      "recommendations",
      "suggestions",
      "compare",
      "difference",
      "differences",
      "explain",
      "detailed",
      "comprehensive",
      "complete",
      "full",
      "everything",
      "show me",
      "give me",
      "provide me",
      "send me",
    ];

    // Check for numeric patterns indicating quantity (e.g., "10 best", "5 ways")
    const numericPattern =
      /\b(\d+)\s+(best|top|ways|steps|items|products|links|options|recommendations|suggestions|examples)\b/i;
    const hasNumericQuantity = numericPattern.test(question);

    // Check if question contains long response keywords
    const hasLongResponseKeyword = longResponseKeywords.some((keyword) =>
      normalizedQuestion.includes(keyword),
    );

    // Check for questions asking for lists or multiple items
    const isListRequest =
      /\b(list|lists|listing)\b/i.test(question) ||
      /\b(all|every|each)\b/i.test(question);

    // Check for questions asking for links/URLs
    const isLinkRequest =
      /\b(link|links|url|urls|website|websites|page|pages)\b/i.test(question);

    // Check for questions asking for detailed explanations
    const isDetailedRequest =
      /\b(explain|describe|detail|detailed|comprehensive|complete|full|everything|how\s+does|how\s+do|what\s+are|what\s+is)\b/i.test(
        question,
      );

    // Determine max_tokens based on query characteristics
    if (
      hasNumericQuantity ||
      (hasLongResponseKeyword && (isListRequest || isLinkRequest))
    ) {
      // For queries asking for specific quantities (e.g., "10 best t-shirts") or lists with links
      // Extract the number if present
      const numberMatch = question.match(/\b(\d+)\b/);
      const requestedQuantity = numberMatch ? parseInt(numberMatch[1], 10) : 5;

      // Calculate tokens: base 200 + (quantity * 50) + extra for links (100 per link)
      // For example: "10 best t-shirts links" = 200 + (10 * 50) + (10 * 100) = 1700 tokens
      if (isLinkRequest) {
        return Math.min(2000, 200 + requestedQuantity * 150); // 150 tokens per link item
      }
      return Math.min(1000, 200 + requestedQuantity * 80); // 80 tokens per list item
    } else if (isLinkRequest && hasLongResponseKeyword) {
      // Multiple links requested without specific number
      return 800;
    } else if (isListRequest || (hasLongResponseKeyword && isDetailedRequest)) {
      // List or detailed explanation requested
      return 600;
    } else if (hasLongResponseKeyword) {
      // Has keywords suggesting longer response but not extreme
      return 400;
    }

    // Default for simple queries
    return 200;
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
      ((/\b(links?|urls?)\b/.test(q) &&
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
      const key = `${url}::${text.slice(0, 120)}`;
      if (!text || seen.has(key)) return;
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

  applyAttributeRerank(matches, queryAttributes, label = "hybrid") {
    if (!matches?.length || !queryAttributes) return matches || [];
    const before = matches.slice(0, 8);
    const reranked = rerankByAttributes(matches, queryAttributes, {
      subIntent: queryAttributes.subIntent,
    });
    logRerankStats(label, before, reranked);
    return reranked;
  }

  async runHybridRetrieval({
    collectionName,
    userIdString,
    semanticTopK,
    catalogKeywords,
    getQuestionEmbedding,
    queryAttributes,
  }) {
    const runKeyword =
      needsKeywordRetrieval(queryAttributes) && catalogKeywords?.length > 0;

    const sizeKeywords = (queryAttributes?.sizes || []).map((s) =>
      s.replace(/\s/g, "").toLowerCase(),
    );
    const keywordList = runKeyword
      ? [...new Set([...sizeKeywords, ...catalogKeywords])]
      : catalogKeywords;

    const [vectorResults, keywordPoints] = await Promise.all([
      this.queryQdrant(
        collectionName,
        await getQuestionEmbedding(),
        semanticTopK,
        userIdString,
        { sizes: queryAttributes?.sizes },
      ),
      runKeyword
        ? this.structuralFetchByKeywords(
            collectionName,
            keywordList,
            userIdString,
            isExplicitSizedCatalogQuery(
              queryAttributes?.normalizedQuestion,
              queryAttributes,
            )
              ? Math.min(120, RAG_KEYWORD_FETCH_MAX)
              : Math.min(80, RAG_KEYWORD_FETCH_MAX),
          )
        : Promise.resolve([]),
    ]);

    if (runKeyword) {
      console.log(
        `[QueryController] Hybrid retrieval: ${vectorResults.length} vector + ${keywordPoints.length} keyword hits`,
      );
    }

    const merged = this.mergeRetrievalResults(vectorResults, keywordPoints);
    return this.applyAttributeRerank(merged, queryAttributes, "hybrid");
  }

  /**
   * Size-filtered catalog matches for list responses.
   */
  selectCatalogMatches(matches, queryAttributes, { strictSize = false } = {}) {
    if (!matches?.length) return [];
    let selected = filterMatchesBySizes(matches, queryAttributes?.sizes || [], {
      strict: strictSize,
    });
    if (queryAttributes?.sizes?.length > 0) {
      const sized = filterMatchesBySizes(matches, queryAttributes.sizes, {
        strict: true,
      });
      if (sized.length > 0) selected = sized;
    }
    return selected;
  }

  buildCatalogListResult(matches, companyName, requestedCount) {
    const listLimits = getContextLimitsForMode("list");
    const contextBlocks = this.buildInPageListContext(matches, {
      ...listLimits,
      requestedCount,
    });
    return {
      context: `The user wants a complete list of items from ${companyName}'s website matching their request. Use ONLY the content below. List EVERY matching item with name, price (if shown), and link. Do not skip items. Do not say information is unavailable if it appears below. Do not suggest other sizes unless the user asked for alternatives.\n\n${contextBlocks}`,
      matches,
      responseMode: "list",
      requestedCount,
    };
  }

  /**
   * Forced catalog list when specialized path bailed but query is explicit sized catalog.
   */
  tryForcedCatalogList({
    question,
    queryResponse,
    queryAttributes,
    companyName,
    requestedTopK,
  }) {
    if (!isExplicitSizedCatalogQuery(question, queryAttributes)) return null;
    if (!queryResponse?.length) return null;

    const requestedCount = this.extractRequestedCount(question, requestedTopK);
    let catalogMatches = this.selectCatalogMatches(
      queryResponse,
      queryAttributes,
      { strictSize: true },
    );

    if (catalogMatches.length === 0) {
      catalogMatches = this.selectCatalogMatches(
        queryResponse,
        queryAttributes,
      );
    }

    catalogMatches = catalogMatches
      .filter((m) =>
        /\b(lash|lashes|product|price|\dmm)\b/i.test(
          `${m.payload?.title || ""} ${m.payload?.text || ""} ${m.payload?.url || ""}`,
        ),
      )
      .slice(0, Math.max(requestedCount * 2, 15));

    if (catalogMatches.length === 0) {
      console.log(
        "[QueryController] Forced catalog: no lash/product matches after size filter",
      );
      return null;
    }

    console.log(
      `[QueryController] Forced catalog list: ${catalogMatches.length} size-matched chunks for sizes [${(queryAttributes.sizes || []).join(", ")}]`,
    );

    return this.buildCatalogListResult(
      catalogMatches,
      companyName,
      requestedCount,
    );
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

  isExplicitInPageListQuestion(question) {
    const q = (question || "").toLowerCase();
    return (
      /\b(featured|homepage|home\s*page|main\s*page)\b/.test(q) ||
      /\b(list|show|give\s+me|what\s+are|share)\b[\s\S]{0,50}\b(products?|items?|options?|styles?|lashes?)\b/.test(
        q,
      ) ||
      (/\b(urls?|links?)\b/.test(q) &&
        /\b\d{1,2}\s*mm\b/.test(q) &&
        /\b(lash|lashes|product)\b/.test(q)) ||
      /\b(all|every|each)\b[\s\S]{0,40}\b(products?|items?|lashes?)\b/.test(
        q,
      ) ||
      /\b(products?|items?|lashes?)\b[\s\S]{0,40}\b(price|prices|cost|pricing)\b/.test(
        q,
      ) ||
      /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
        q,
      ) ||
      (/\b\d{1,2}\s*mm\b/.test(q) &&
        /\b(options?|styles?|products?|lashes?|share|more)\b/.test(q))
    );
  }

  isExplicitPageLinksQuestion(question) {
    const q = (question || "").toLowerCase();
    if (this.isExplicitInPageListQuestion(question)) return false;
    if (isProductLinkRequest(question)) return true;
    return (
      (/\b(links?|urls?)\b/.test(q) &&
        /\b(list|show|give|share|send|all|every|how\s+many|more)\b/.test(q)) ||
      (/\b(url|link)\b/.test(q) &&
        /\b\d{1,2}\s*mm\b/.test(q) &&
        /\b(lash|lashes|product|style|collection)\b/.test(q)) ||
      /\bshow\s+me\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      /\b(share|send)\b[\s\S]{0,40}\b(urls?|links?)\b/.test(q) ||
      /\blist\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      (/\b(pages?)\b/.test(q) &&
        /\b(list|show|give|share|all|site|website)\b/.test(q)) ||
      (/\b(collections?)\b/.test(q) &&
        /\b(list|show|all|pages?|links?|share)\b/.test(q))
    );
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

  /**
   * Attempt specialized hybrid retrieval. Returns null when quality is too low
   * so the caller falls through to standard semantic RAG.
   */
  async trySpecializedRetrieval({
    subIntent,
    question,
    keywordSource,
    collectionName,
    userIdString,
    requestedTopK,
    companyName,
    semanticMatches,
    getQuestionEmbedding,
    wantsProductLinks = false,
    catalogKeywords = null,
    queryAttributes = null,
  }) {
    const maxSemantic = this.getMaxSemanticScore(semanticMatches);
    const hasGoodSemantic = maxSemantic >= 0.32;
    const requestedCount = this.extractRequestedCount(question, requestedTopK);

    if (subIntent === "IN_PAGE_LIST") {
      if (!this.isExplicitInPageListQuestion(question) && !wantsProductLinks) {
        console.log(
          "[QueryController] IN_PAGE_LIST skipped: not an explicit catalog/homepage request",
        );
        return null;
      }

      const keywords =
        catalogKeywords && catalogKeywords.length > 0
          ? catalogKeywords
          : this.extractKeywords(keywordSource);
      const keywordPoints = await this.structuralFetchByKeywords(
        collectionName,
        keywords.length > 0 ? keywords : ["featured", "product"],
        userIdString,
        keywordFetchLimit(requestedCount, 3, 40),
      );

      let mergedMatches = this.mergeRetrievalResults(
        semanticMatches,
        keywordPoints,
      );
      mergedMatches = this.applyAttributeRerank(
        mergedMatches,
        queryAttributes,
        "IN_PAGE_LIST",
      );

      if (/\b(homepage|home\s*page|main\s*page)\b/i.test(question)) {
        const homepageMatches = mergedMatches.filter((m) =>
          this.isHomepageUrl(m.payload?.url),
        );
        if (homepageMatches.length > 0) {
          mergedMatches = homepageMatches;
        }
      }

      const structuralHits = this.countStrongStructuralHits(
        keywords,
        keywordPoints,
      );

      const forcedCatalog = isExplicitSizedCatalogQuery(
        question,
        queryAttributes,
      );
      let catalogMatches = this.selectCatalogMatches(
        mergedMatches,
        queryAttributes,
        { strictSize: forcedCatalog },
      );
      if (catalogMatches.length === 0 && !forcedCatalog) {
        catalogMatches = mergedMatches;
      }

      if (
        !forcedCatalog &&
        !hasGoodSemantic &&
        structuralHits < 2 &&
        mergedMatches.length < 2
      ) {
        console.log(
          "[QueryController] IN_PAGE_LIST skipped: weak semantic and keyword retrieval",
        );
        return null;
      }

      if (forcedCatalog && catalogMatches.length === 0) {
        console.log(
          "[QueryController] IN_PAGE_LIST forced catalog: no matches after size filter",
        );
        return null;
      }

      const listLimits = getContextLimitsForMode("list");
      const contextBlocks = this.buildInPageListContext(catalogMatches, {
        ...listLimits,
        requestedCount,
      });
      return {
        context: `The user wants a complete list of items from ${companyName}'s website matching their size/style request. Use ONLY the content below. List EVERY matching item with name, price (if shown), and link. Do not skip items. Do not say information is unavailable if it appears below. Do not suggest unrelated sizes.\n\n${contextBlocks}`,
        matches: catalogMatches,
        responseMode: "list",
        requestedCount,
      };
    }

    if (subIntent === "CONTACT_INFO") {
      if (!this.isPrimarilyContactQuestion(question)) {
        console.log(
          "[QueryController] CONTACT_INFO skipped: question is not primarily about contact details",
        );
        return null;
      }

      const keywords = this.extractContactKeywords(keywordSource);
      const footerPoints = await this.structuralFetchByKeywords(
        collectionName,
        ["footer links", "footer"],
        userIdString,
        80,
      );
      const keywordPoints = await this.structuralFetchByKeywords(
        collectionName,
        keywords,
        userIdString,
        keywordFetchLimit(requestedCount, 2, 40),
      );

      let mergedMatches = this.mergeRetrievalResults(semanticMatches, [
        ...footerPoints,
        ...keywordPoints,
      ]);
      mergedMatches = this.applyAttributeRerank(
        mergedMatches,
        queryAttributes,
        "CONTACT_INFO",
      );
      mergedMatches = this.prioritizeFooterChunks(mergedMatches);

      const hasFooter = footerPoints.length > 0;
      const structuralHits = this.countStrongStructuralHits(
        keywords,
        keywordPoints,
      );

      if (!hasGoodSemantic && !hasFooter && structuralHits < 1) {
        console.log(
          "[QueryController] CONTACT_INFO skipped: no footer/contact keyword hits and weak semantic",
        );
        return null;
      }

      if (mergedMatches.length === 0) return null;

      const contactLimits = getContextLimitsForMode("contact");
      const contextBlocks = this.getRelevantContext(mergedMatches, contactLimits);
      return {
        context: `The user is asking about contact information, social media profiles, phone, email, address, or business hours for ${companyName}. Use ONLY the content below. Include every social media URL and relevant contact detail found. Do not say information is missing if it appears below.\n\n${contextBlocks}`,
        matches: mergedMatches,
        responseMode: "contact",
        requestedCount,
      };
    }

    if (subIntent === "PAGE_LINKS") {
      if (!this.isExplicitPageLinksQuestion(question) && !wantsProductLinks) {
        console.log(
          "[QueryController] PAGE_LINKS skipped: not an explicit page/URL listing request",
        );
        return null;
      }

      const keywords = this.extractKeywords(keywordSource);
      const keywordPoints = await this.structuralFetchByKeywords(
        collectionName,
        keywords,
        userIdString,
        keywordFetchLimit(requestedCount, 2, 50),
      );

      const uniquePages = this.dedupeByUrl(keywordPoints);
      const structuralHits = this.countStrongStructuralHits(
        keywords,
        keywordPoints,
      );
      const minPages = wantsProductLinks ? 1 : 2;

      if (
        uniquePages.length >= minPages &&
        (structuralHits >= 1 || wantsProductLinks) &&
        (hasGoodSemantic || uniquePages.length >= minPages)
      ) {
        const topItems = uniquePages.slice(0, requestedCount);
        const pagesLines = topItems
          .map((p, idx) => {
            const url = p.url || "";
            const title = p.title || p.url || `Page ${idx + 1}`;
            return `${idx + 1}. ${title} — ${url}`;
          })
          .join("\n");

        return {
          context: `The user wants pages or items from ${companyName}'s site. These ${topItems.length} knowledge-base pages match (use every entry; keep exact URLs and titles):\n\n${pagesLines}\n\nReply in clean HTML: a short, natural lead if it helps, then a <ul> of <li> items with links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">title</a>. Do not use a fixed opener like "Here are N links:" unless it truly fits; sound human and direct.`,
          matches: topItems.map((payload) => ({ payload })),
          responseMode: "page_links",
          requestedCount,
        };
      }

      if (hasGoodSemantic) {
        console.log(
          "[QueryController] PAGE_LINKS skipped: using semantic path (better relevance)",
        );
        return null;
      }

      const mergedMatches = this.applyAttributeRerank(
        this.mergeRetrievalResults(semanticMatches, keywordPoints),
        queryAttributes,
        "PAGE_LINKS",
      );
      if (mergedMatches.length > 0 && wantsProductLinks) {
        const linkLimits = getContextLimitsForMode("page_links");
        const pagesLines = this.buildCompactPageLinksContext(mergedMatches, {
          ...linkLimits,
          requestedCount,
        });
        return {
          context: `The user wants product or collection page links from ${companyName}. Use ONLY the entries below. Include every matching URL as a clickable link. Do not say products are unavailable if they appear below.\n\n${pagesLines}`,
          matches: mergedMatches,
          responseMode: "page_links",
          requestedCount,
        };
      }

      if (mergedMatches.length === 0) return null;

      console.log(
        "[QueryController] PAGE_LINKS downgraded to semantic-style answer (weak URL matches)",
      );
      return null;
    }

    return null;
  }

  extractContactKeywords(query) {
    const q = (query || "").toLowerCase();
    const keywords = new Set(this.extractKeywords(query));

    const platformNames = [
      "facebook",
      "instagram",
      "twitter",
      "youtube",
      "tiktok",
      "linkedin",
      "pinterest",
    ];

    for (const name of platformNames) {
      if (q.includes(name)) keywords.add(name);
    }

    if (/\bsocial\b/.test(q) || /\bsocial\s*media\b/.test(q)) {
      for (const name of platformNames) keywords.add(name);
      keywords.add("footer");
    }

    if (/\b(phone|call|text|fax|tel)\b/.test(q)) {
      keywords.add("phone");
      keywords.add("call");
      keywords.add("footer");
    }

    if (/\b(email|e-mail|mailto)\b/.test(q)) {
      keywords.add("email");
      keywords.add("footer");
    }

    if (/\b(address|mailing|location)\b/.test(q)) {
      keywords.add("address");
      keywords.add("mailing");
      keywords.add("footer");
    }

    if (/\b(hours|office)\b/.test(q)) {
      keywords.add("hours");
      keywords.add("footer");
    }

    keywords.add("footer");
    return Array.from(keywords).filter((w) => w.length > 2);
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
      const text = stripHtmlForContext(payload.text || payload.pageContent || "");
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
      const line = `${i + 1}. ${title} — ${url}`;
      if (totalChars + line.length + 1 > maxTotalChars) break;
      lines.push(line);
      totalChars += line.length + 1;
    }

    return lines.join("\n");
  }

  matchesToSources(matches) {
    const seenSourceKeys = new Set();
    return (matches || [])
      .map((match) => {
        const payload = match.payload || {};
        const sourceType = payload.type !== undefined ? payload.type : null;
        const title = payload.title || payload.url || null;
        const url = payload.url || null;
        return { type: sourceType, title, url };
      })
      .filter(({ type, title, url }) => {
        if (type === null && !title && !url) return false;
        const key = url || title;
        if (!key || seenSourceKeys.has(key)) return false;
        seenSourceKeys.add(key);
        return true;
      });
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
    } = answerOptions;

    const effectiveMode =
      wantsProductUrls && responseMode === "brief" ? "list" : responseMode;
    const chatModel = selectChatModel({
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
      { requestedCount, wantsProductUrls },
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
      const dynamicMaxTokens = this.determineMaxTokens(question, effectiveMode);

      // Log when dynamic token limit is applied (only if different from default)
      if (dynamicMaxTokens > 200) {
        console.log(
          `[QueryController] Dynamic token limit applied: ${dynamicMaxTokens} tokens for query: "${question.substring(0, 60)}..."`,
        );
      }

      if (chatModel !== CHAT_MODEL_BRIEF) {
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
          effectiveMode === "page_links"
            ? 0
            : 0.4,
        ...chatCompletionLimitPayload(dynamicMaxTokens, chatModel),
      });

      const answer =
        response.choices[0]?.message?.content?.trim() ||
        "I apologize, I encountered an issue generating a response.";
      const usage = response.usage;

      return { answer, usage, model: chatModel, source: "llm" };
    } catch (error) {
      console.error("Error generating answer with OpenAI:", error);
      return {
        answer: "I apologize, I encountered an issue generating a response.",
        usage: null,
        model: chatModel,
        source: "llm_error",
      };
    }
  }

  // Context extraction for Qdrant results — always include source URL/title when available
  getRelevantContext(matches, options = {}) {
    const maxChunkChars = options.maxChunkChars ?? RAG_MAX_CHUNK_CHARS;
    const maxTotalChars = options.maxTotalChars ?? RAG_MAX_CONTEXT_CHARS;
    let totalChars = 0;
    const blocks = [];

    for (const match of matches || []) {
      const payload = match.payload || {};
      let text = stripHtmlForContext(payload.text || payload.pageContent || "");
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
      { key: "url",     match: { value: url } },
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
        (best, p) => ((p.payload?.created_at || "") > best ? p.payload.created_at : best),
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
   * Page-merge context builder (replaces getRelevantContext for "brief" mode).
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
      maxTotalChars  = RAG_MAX_CONTEXT_CHARS,
      maxChunkChars  = RAG_MAX_CHUNK_CHARS,
      maxUrlsToExpand = 3,
      maxChunksPerUrl = 25,
    } = options;

    // Require Qdrant access params; fall back gracefully
    if (!collectionName || !userId) {
      console.warn("[QueryController] buildPageMergeContext: missing collectionName or userId, falling back to getRelevantContext");
      return this.getRelevantContext(matches, options);
    }

    // --- Step 1 & 2: group by URL and rank ---
    const urlMap = new Map(); // groupKey -> { url, title, maxScore, hitCount }

    for (const match of matches || []) {
      const payload  = match.payload || {};
      const url      = payload.url   || "";
      const title    = payload.title || url || "";
      const text     = stripHtmlForContext(payload.text || payload.pageContent || "");
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
      console.log("[QueryController] buildPageMergeContext: no non-boilerplate URLs found, falling back to getRelevantContext");
      return this.getRelevantContext(matches, options);
    }

    console.log(
      `[QueryController] buildPageMergeContext: expanding ${rankedUrls.length} URL(s) — ` +
      rankedUrls.map((u) => `${u.url || u.title} (score=${u.rankScore.toFixed(3)})`).join(", "),
    );

    // --- Steps 3–7: fetch, dedup, filter, merge per URL ---
    const blocks = [];
    let totalChars = 0;

    for (const { url, title } of rankedUrls) {
      if (!url || totalChars >= maxTotalChars) break;

      try {
        const allPoints = await this.fetchAllChunksForUrl(
          collectionName, url, userId, agentId,
        );

        if (allPoints.length === 0) {
          console.log(`[QueryController] buildPageMergeContext: no Qdrant points found for ${url}`);
          continue;
        }

        const sorted = this.deduplicateAndSortChunks(allPoints);

        // Filter boilerplate and cap chunk count
        const validChunks = sorted
          .filter((p) => !isBoilerplateChunk(stripHtmlForContext(p.payload?.text || "")))
          .slice(0, maxChunksPerUrl);

        if (validChunks.length === 0) {
          console.log(`[QueryController] buildPageMergeContext: all chunks were boilerplate for ${url}`);
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
        console.warn(`[QueryController] buildPageMergeContext: fetch failed for ${url}: ${err.message}`);
      }
    }

    if (blocks.length === 0) {
      console.log("[QueryController] buildPageMergeContext: expansion yielded no content, falling back to getRelevantContext");
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

      // First try with user_id filter
      let searchResult = [];
      const sizeTokens = (options.sizes || [])
        .map((s) => s.replace(/\s/g, "").toLowerCase())
        .filter(Boolean);

      const buildFilter = (withSizeBoost = false) => {
        const must = [];
        if (userId) {
          must.push({
            key: "user_id",
            match: { value: userId.toString() },
          });
        }
        if (withSizeBoost && sizeTokens.length > 0) {
          must.push({
            key: "sizes",
            match: { any: sizeTokens },
          });
        }
        return must.length > 0 ? { must } : undefined;
      };

      if (userId) {
        try {
          if (sizeTokens.length > 0) {
            try {
              await this.qdrantClient.createPayloadIndex(collectionName, {
                field_name: "sizes",
                field_schema: "keyword",
              });
            } catch (e) {
              if (!e.message?.includes("already exists")) {
                console.warn(`[QueryController] sizes index: ${e.message}`);
              }
            }
          }

          const sizedFilter = buildFilter(sizeTokens.length > 0);
          if (sizedFilter) {
            searchResult = await this.qdrantClient.search(collectionName, {
              vector: queryEmbedding,
              limit: topK,
              with_payload: true,
              filter: sizedFilter,
            });
            console.log(
              `[QueryController] Query with size filter [${sizeTokens.join(", ")}] returned ${searchResult.length} results`,
            );
          }

          if (searchResult.length === 0) {
            searchResult = await this.qdrantClient.search(collectionName, {
              vector: queryEmbedding,
              limit: topK,
              with_payload: true,
              filter: buildFilter(false),
            });
            console.log(
              `[QueryController] Query with user_id filter returned ${searchResult.length} results`,
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
        // No userId provided, query without filter
        searchResult = await this.qdrantClient.search(collectionName, {
          vector: queryEmbedding,
          limit: topK,
          with_payload: true,
        });
        console.log(
          `[QueryController] Query without user_id filter returned ${searchResult.length} results`,
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
    const { topK = 5, scoreThreshold = 0.4 } = options;
    // Coerce to a safe numeric value so downstream logic is consistent
    const requestedTopK = Math.max(1, Number(topK) || 5);

    try {
      // 1. Get Chat History
      const chatSession = await this.getChatHistory(conversationId);
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

      // Intent classification FIRST (rules → gpt-4.1-nano)
      const routing = await routeQuery(normalizedQuestion, {
        chatMessages: chatSession,
        websiteLanguage,
        openaiClient: openai,
      });

      console.log(
        `[QueryController] Route: ${routing.route} | subIntent: ${routing.subIntent} | userLang: ${routing.userLanguage} | confidence: ${routing.confidence} | source: ${routing.source}`,
      );

      const langOpts = { userLanguage: routing.userLanguage };

      if (routing.route === ROUTES.GREETING) {
        if (!isPureGreeting(question)) {
          console.log(
            `[QueryController] GREETING route overridden for compound message: "${question.substring(0, 60)}..."`,
          );
          routing.route = ROUTES.SEMANTIC_RAG;
          routing.subIntent = null;
        } else if (USE_LIGHTWEIGHT_RESPONSES) {
          return await this.respondToGreeting({
            question,
            companyName,
            routing,
            websiteLanguage,
            options,
            conversationId,
          });
        } else {
          const greetingHistory = getChatHistoryFormatted(
            CHAT_HISTORY_LIMIT_BRIEF,
          );
          const greetingResult = await this.generateAnswer(
            question,
            `This is a greeting. The user said: "${question}". Respond warmly and naturally, as a human customer support agent would. Ask how you can help regarding ${companyName} in a friendly, conversational way.`,
            greetingHistory,
            companyName,
            websiteData,
            langOpts,
          );
          this.logAnswerUsage(userId, agentId, greetingResult);
          return {
            success: true,
            answer: greetingResult.answer,
            conversationId,
            isAgentRequest: false,
          };
        }
      }

      if (routing.route === ROUTES.ACCIDENTAL && USE_LIGHTWEIGHT_RESPONSES) {
        return this.respondToAccidental({
          question,
          companyName,
          routing,
          websiteLanguage,
          options,
          conversationId,
        });
      }

      if (routing.route === ROUTES.LIVE_AGENT && USE_LIGHTWEIGHT_RESPONSES) {
        return this.respondToLiveAgent({
          question,
          companyName,
          routing,
          websiteLanguage,
          options,
          conversationId,
        });
      }

      const queryExpansion = expandQueryForRetrieval(
        normalizedQuestion,
        chatSession,
        { sizes: queryNorm.sizes },
      );
      const {
        retrievalQuery,
        wasExpanded,
        wantsProductLinks,
        isCatalogQuery,
        currentSizes,
      } = queryExpansion;

      const embeddingQuery = queryNorm.enrichForEmbedding(retrievalQuery);

      if (wasExpanded) {
        console.log(
          `[QueryController] Expanded retrieval query: "${retrievalQuery}"`,
        );
      }
      if (embeddingQuery !== retrievalQuery) {
        console.log(
          `[QueryController] Enriched embedding query: "${embeddingQuery}"`,
        );
      }

      const subIntent = routing.subIntent || null;
      let effectiveSubIntent = subIntent;
      const hasSizeFilter =
        (queryNorm.sizes?.length > 0 || currentSizes?.length > 0) &&
        /\b(lash|lashes|product|style|collection)\b/i.test(normalizedQuestion);

      if (wantsProductLinks && !effectiveSubIntent) {
        effectiveSubIntent = /\b\d{1,2}(?:-\d{1,2})?mm\b/i.test(retrievalQuery)
          ? "IN_PAGE_LIST"
          : "PAGE_LINKS";
      } else if (
        isCatalogQuery &&
        (wasExpanded || hasSizeFilter) &&
        !effectiveSubIntent
      ) {
        effectiveSubIntent = "IN_PAGE_LIST";
      } else if (hasSizeFilter && !effectiveSubIntent) {
        effectiveSubIntent = "IN_PAGE_LIST";
      }

      const queryAttributes = extractQueryAttributes({
        normalizedQuestion,
        queryNorm,
        queryExpansion,
        routing,
        subIntent: effectiveSubIntent,
      });

      // console.log(
      //   `[QueryController] Attributes: sizes=[${queryAttributes.sizes.join(", ")}] collections=[${queryAttributes.collections.join(", ")}] keywords=${queryAttributes.keywords.length} flags=${JSON.stringify(queryAttributes.flags)}`
      // );

      // const embeddingQuery = queryAttributes.embeddingQuery;
      // if (embeddingQuery !== retrievalQuery) {
      //   console.log(
      //     `[QueryController] Enriched embedding query: "${embeddingQuery}"`
      //   );
      // }

      const catalogKeywords =
        queryAttributes.keywords.length > 0
          ? queryAttributes.keywords
          : this.buildCatalogKeywords(queryAttributes.keywordSource, {
              ...queryNorm,
              sizes: queryNorm.sizes?.length
                ? queryNorm.sizes
                : currentSizes || [],
            });

      let questionEmbedding = null;
      const getQuestionEmbedding = async () => {
        if (!questionEmbedding) {
          questionEmbedding =
            await this.embeddingModel.embedQuery(embeddingQuery);
          if (!questionEmbedding) {
            throw new Error("Failed to generate question embedding.");
          }
        }
        return questionEmbedding;
      };

      let semanticTopK =
        effectiveSubIntent === "IN_PAGE_LIST"
          ? Math.max(
              10,
              Math.min(
                20,
                this.extractRequestedCount(question, requestedTopK) * 3,
              ),
            )
          : effectiveSubIntent === "CONTACT_INFO"
            ? 12
            : effectiveSubIntent === "PAGE_LINKS"
              ? Math.max(
                  requestedTopK,
                  this.extractRequestedCount(question, requestedTopK) * 2,
                )
              : requestedTopK;

      if (isCatalogQuery || wantsProductLinks) {
        semanticTopK = Math.max(semanticTopK, 15);
      }

      let queryResponse = await this.runHybridRetrieval({
        collectionName,
        userIdString,
        semanticTopK,
        catalogKeywords,
        getQuestionEmbedding,
        queryAttributes,
      });

      if (effectiveSubIntent) {
        const specialized = await this.trySpecializedRetrieval({
          subIntent: effectiveSubIntent,
          question,
          keywordSource: queryAttributes.keywordSource,
          collectionName,
          userIdString,
          requestedTopK,
          companyName,
          semanticMatches: queryResponse,
          getQuestionEmbedding,
          wantsProductLinks,
          catalogKeywords,
          queryAttributes,
        });

        if (specialized) {
          const specializedResult = await this.generateAnswerFromMatches({
            question,
            matches: specialized.matches,
            chatHistory: getChatHistoryFormatted(CHAT_HISTORY_LIMIT),
            organisation: companyName,
            websiteData,
            answerOptions: {
              responseMode: specialized.responseMode,
              requestedCount: specialized.requestedCount,
              wantsProductUrls: wantsProductLinks,
              prebuiltContext: specialized.context,
              wasExpanded,
              retrievalMaxScore: this.getMaxSemanticScore(specialized.matches),
              ...langOpts,
            },
          });

          this.logAnswerUsage(userId, agentId, specializedResult);

          return {
            success: true,
            answer: specializedResult.answer,
            sources: this.matchesToSources(specialized.matches),
            conversationId,
            isAgentRequest: false,
          };
        }
      }

      const forcedCatalog = this.tryForcedCatalogList({
        question: normalizedQuestion,
        queryResponse,
        queryAttributes,
        companyName,
        requestedTopK,
      });

      if (forcedCatalog) {
        const forcedResult = await this.generateAnswerFromMatches({
          question,
          matches: forcedCatalog.matches,
          chatHistory: getChatHistoryFormatted(CHAT_HISTORY_LIMIT),
          organisation: companyName,
          websiteData,
          answerOptions: {
            responseMode: forcedCatalog.responseMode,
            requestedCount: forcedCatalog.requestedCount,
            wantsProductUrls: wantsProductLinks,
            prebuiltContext: forcedCatalog.context,
            wasExpanded,
            retrievalMaxScore: this.getMaxSemanticScore(forcedCatalog.matches),
            ...langOpts,
          },
        });

        this.logAnswerUsage(userId, agentId, forcedResult);

        return {
          success: true,
          answer: forcedResult.answer,
          sources: this.matchesToSources(forcedCatalog.matches),
          conversationId,
          isAgentRequest: false,
        };
      }

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

      // Get threshold from widget settings or use default/options
      const widgetThreshold = widgetData?.scoreThreshold;
      let effectiveThreshold =
        widgetThreshold !== undefined ? widgetThreshold : scoreThreshold;

      const sizedCatalogQuery = isExplicitSizedCatalogQuery(
        normalizedQuestion,
        queryAttributes,
      );
      const catalogListQuery =
        sizedCatalogQuery ||
        (effectiveSubIntent === "IN_PAGE_LIST" &&
          this.isExplicitInPageListQuestion(normalizedQuestion));

      // Warn if threshold is very low (may include irrelevant results)
      if (effectiveThreshold < 0.3) {
        console.warn(
          `[QueryController] Low score threshold (${effectiveThreshold}) may include irrelevant results. Consider using 0.4-0.5 for better quality.`,
        );
      }

      // Filter matches by score threshold (bypass for explicit catalog list queries)
      let relevantMatches = catalogListQuery
        ? this.selectCatalogMatches(queryResponse, queryAttributes, {
            strictSize: sizedCatalogQuery,
          }).slice(0, Math.max(requestedTopK * 2, 15))
        : queryResponse.filter((match) => match.score >= effectiveThreshold);

      if (catalogListQuery && relevantMatches.length > 0) {
        console.log(
          `[QueryController] Catalog list bypass: using ${relevantMatches.length} size-matched chunks (threshold bypassed)`,
        );
      }

      // Check if query is completely irrelevant (all scores are very low)
      const maxScore =
        queryResponse.length > 0
          ? Math.max(...queryResponse.map((m) => m.score))
          : 0;

      const clearlyOnTopic = this.isClearlyOnTopicCompanyQuestion(
        normalizedQuestion,
        companyName,
      );
      if (clearlyOnTopic) {
        console.log(
          `[QueryController] On-topic company question detected: "${question.substring(0, 60)}..."`,
        );
      }

      const IRRELEVANT_THRESHOLD = 0.3;
      const isIrrelevant =
        !catalogListQuery &&
        !clearlyOnTopic &&
        queryResponse.length > 0 &&
        maxScore < IRRELEVANT_THRESHOLD;

      if (isIrrelevant) {
        console.warn(
          `[QueryController] IRRELEVANT QUERY DETECTED: "${question.substring(0, 50)}..." | Max similarity score: ${maxScore.toFixed(3)} (below threshold ${IRRELEVANT_THRESHOLD}). Will redirect user.`,
        );
      }

      // If no matches found with current threshold, try with a lower threshold as fallback
      if (
        relevantMatches.length === 0 &&
        queryResponse.length > 0 &&
        (!isIrrelevant || clearlyOnTopic)
      ) {
        const fallbackThreshold = Math.max(0.2, effectiveThreshold - 0.15); // Lower by 0.15 but not below 0.2
        console.warn(
          `[QueryController] No matches above threshold ${effectiveThreshold}. Trying fallback threshold ${fallbackThreshold.toFixed(
            2,
          )}...`,
        );
        const fallbackMatches = queryResponse.filter(
          (match) => match.score >= fallbackThreshold,
        );
        if (fallbackMatches.length > 0) {
          relevantMatches = fallbackMatches;
          effectiveThreshold = fallbackThreshold;
          console.log(
            `[QueryController] Fallback threshold found ${fallbackMatches.length} matches. Using these results.`,
          );
        }
      }

      // If we still have fewer matches than requested, relax threshold by
      // bringing back the highest-scoring remaining results (but keep
      // ordering and avoid irrelevant queries).
      if (
        (!isIrrelevant || clearlyOnTopic) &&
        queryResponse.length > 0 &&
        relevantMatches.length < requestedTopK
      ) {
        const needed = requestedTopK - relevantMatches.length;
        const supplemental = [...queryResponse]
          .sort((a, b) => b.score - a.score)
          .filter((m) => !relevantMatches.find((r) => r.id === m.id))
          .slice(0, needed);

        if (supplemental.length > 0) {
          console.warn(
            `[QueryController] Only ${relevantMatches.length} matches met threshold ${effectiveThreshold}. Adding ${supplemental.length} top-scoring remaining matches to reach requested topK ${requestedTopK}.`,
          );
          relevantMatches = [...relevantMatches, ...supplemental];
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
          50,
        )}..." | Collection: ${collectionName} | Found: ${
          queryResponse.length
        } matches, ${
          relevantMatches.length
        } relevant (threshold: ${effectiveThreshold})`,
      );
      if (scoreStats) {
        console.log(
          `[QueryController] Score stats - Min: ${scoreStats.min.toFixed(
            3,
          )}, Max: ${scoreStats.max.toFixed(3)}, Avg: ${scoreStats.avg.toFixed(
            3,
          )} | Scores: [${scoreStats.scores.slice(0, 5).join(", ")}${
            scoreStats.scores.length > 5 ? "..." : ""
          }]`,
        );
      }
      if (queryResponse.length > 0 && relevantMatches.length === 0) {
        console.warn(
          `[QueryController] WARNING: Found ${queryResponse.length} matches but ALL were below threshold ${effectiveThreshold}. Consider lowering threshold or checking data quality.`,
        );
      }

      let finalAnswer;
      // let completionUsage = null;

      // Check if message looks accidental or like test input
      const isAccidental = this.isAccidentalOrTestMessage(question);

      // Check if visitor is requesting to connect to an agent
      const isAgentRequest = isLiveAgentRequest(question);

      // Handle simple greetings even without context
      if (relevantMatches.length === 0 && this.isSimpleGreeting(question)) {
        if (USE_LIGHTWEIGHT_RESPONSES) {
          const greetingResult = await this.respondToGreeting({
            question,
            companyName,
            routing,
            websiteLanguage,
            options,
            conversationId,
          });
          finalAnswer = greetingResult.answer;
        } else {
          const greetingHistory = getChatHistoryFormatted(
            CHAT_HISTORY_LIMIT_BRIEF,
          );
          const greetingResult = await this.generateAnswer(
            question,
            `This is a greeting. The user said: "${question}". Respond warmly and naturally, as a human customer support agent would. Ask how you can help regarding ${companyName} in a friendly, conversational way.`,
            greetingHistory,
            companyName,
            websiteData,
            langOpts,
          );
          finalAnswer = greetingResult.answer;
          this.logAnswerUsage(userId, agentId, greetingResult);
        }
      } else if (isAccidental && !this.isSimpleGreeting(question)) {
        if (USE_LIGHTWEIGHT_RESPONSES) {
          const accidentalResult = this.respondToAccidental({
            question,
            companyName,
            routing,
            websiteLanguage,
            options,
            conversationId,
          });
          finalAnswer = accidentalResult.answer;
        } else {
          const accidentalHistory = getChatHistoryFormatted(
            CHAT_HISTORY_LIMIT_BRIEF,
          );
          const accidentalResult = await this.generateAnswer(
            question,
            `The user sent a message that looks accidental or like test input: "${question}". This appears to be random characters or accidental typing. Acknowledge it might have been sent by accident, be friendly and understanding, and offer help with ${companyName}'s services. Respond naturally as a human would, not robotically.`,
            accidentalHistory,
            companyName,
            websiteData,
            langOpts,
          );
          finalAnswer = accidentalResult.answer;
          this.logAnswerUsage(userId, agentId, accidentalResult);
        }
      } else if (
        clearlyOnTopic &&
        (relevantMatches.length === 0 || maxScore < IRRELEVANT_THRESHOLD) &&
        !this.isSimpleGreeting(question) &&
        !isAccidental
      ) {
        const onTopicResult = await this.answerOnTopicWithFallback({
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
        });
        finalAnswer = onTopicResult.answer;
      } else if (
        (relevantMatches.length === 0 || isIrrelevant) &&
        !clearlyOnTopic &&
        !this.isSimpleGreeting(question) &&
        !isAccidental
      ) {
        const useLightTemplate =
          USE_LIGHTWEIGHT_RESPONSES &&
          (isIrrelevant || isTrulyOffTopicQuestion(normalizedQuestion));

        if (useLightTemplate) {
          const offTopicResult = this.respondToOffTopic({
            question,
            companyName,
            routing,
            websiteLanguage,
            options,
            conversationId,
            isIrrelevant,
          });
          finalAnswer = offTopicResult.answer;
        } else {
          const contextMessage = isIrrelevant
            ? `The user asked: "${question}". This question is completely unrelated to ${companyName} (similarity score: ${maxScore.toFixed(3)}). Redirect politely and offer help with ${companyName}'s services.`
            : `The user asked: "${question}". This question may not be directly related to ${companyName}. Redirect politely and offer help with relevant topics.`;

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
          this.logAnswerUsage(userId, agentId, offTopicResult);
        }
      } else {
        const wantsUrls = wantsProductLinks || isProductLinkRequest(question);
        const listFallback =
          wantsUrls ||
          hasSizeFilter ||
          (effectiveSubIntent === "IN_PAGE_LIST" &&
            this.isExplicitInPageListQuestion(normalizedQuestion));
        const contactFallback =
          effectiveSubIntent === "CONTACT_INFO" &&
          this.isPrimarilyContactQuestion(question);
        const requestedCount = this.extractRequestedCount(
          question,
          requestedTopK,
        );
        const responseMode = listFallback
          ? "list"
          : contactFallback
            ? "contact"
            : "brief";
        const historyLimit = isPremiumResponseMode(responseMode)
          ? CHAT_HISTORY_LIMIT
          : CHAT_HISTORY_LIMIT_BRIEF;

        const answerResult = await this.generateAnswerFromMatches({
          question,
          matches: relevantMatches,
          chatHistory: getChatHistoryFormatted(historyLimit),
          organisation: companyName,
          websiteData,
          answerOptions: {
            responseMode,
            requestedCount,
            wantsProductUrls: wantsUrls,
            wasExpanded,
            retrievalMaxScore: maxScore,
            // Pass Qdrant access params so buildPageMergeContext can expand pages
            collectionName,
            userId: userIdString,
            agentId: agentId?.toString(),
            ...langOpts,
          },
        });
        finalAnswer = answerResult.answer;
        this.logAnswerUsage(userId, agentId, answerResult);
      }

      // 10. Prepare Sources from Qdrant matched payloads
      // Use full retrieval set (not threshold-filtered) so citations appear even when
      // scores are low, irrelevant redirect runs, or LLM context used only "relevant" hits.
      const matchesForSources =
        queryResponse.length > 0
          ? [...queryResponse].sort((a, b) => b.score - a.score)
          : [];
      const seenSourceKeys = new Set();
      const sources = matchesForSources
        .map((match) => {
          const payload = match.payload || {};
          const sourceType = payload.type !== undefined ? payload.type : null;
          const title = payload.title || payload.url || null;
          const url = payload.url || null;
          return { type: sourceType, title, url };
        })
        .filter(({ type, title, url }) => {
          // Keep only entries with some identifier
          if (type === null && !title && !url) return false;
          // Deduplicate by url (for webpages) or title (for others)
          const key = url || title;
          if (!key || seenSourceKeys.has(key)) return false;
          seenSourceKeys.add(key);
          return true;
        });

      return {
        success: true,
        answer: finalAnswer,
        sources: sources.length > 0 ? sources : undefined,
        conversationId,
        isAgentRequest: isAgentRequest || false,
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
