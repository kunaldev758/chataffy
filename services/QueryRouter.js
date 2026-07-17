require("dotenv").config();
const { getResolvedModelConfig } = require("./aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("./providerChatComplete");
const { normalizeLanguageCode, detectLanguageFromText } = require("../utils/websiteLanguage");
const {
  detectCatalogFollowUp,
  isProductLinkRequest,
  expandQueryForRetrieval,
} = require("../utils/queryContextExpansion");
const {
  formatStateForRouter,
  topicsFromRagState,
  hasCatalogThreadFromState,
} = require("./conversationStateService");
const { normalizeQueryText } = require("../utils/queryNormalization");
const { isContactIntentQuestion } = require("../utils/contactIntentDetection");
const {
  normalizeGreetingInput,
  isGibberishOrAccidentalMessage,
  detectScriptLanguage,
} = require("./LightweightResponseService");

const ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || "gpt-4.1-nano";

const ROUTES = {
  GREETING: "GREETING",
  LIVE_AGENT: "LIVE_AGENT",
  ACCIDENTAL: "ACCIDENTAL",
  ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT",
  STRUCTURAL: "STRUCTURAL",
  SEMANTIC_RAG: "SEMANTIC_RAG",
  HYBRID: "HYBRID",
};

const SUB_INTENTS = {
  IN_PAGE_LIST: "IN_PAGE_LIST",
  CONTACT_INFO: "CONTACT_INFO",
  PAGE_LINKS: "PAGE_LINKS",
};

const GREETINGS = [
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
  "hola",
  "buenos días",
  "buenas tardes",
  "buenas noches",
  "bonjour",
  "ciao",
  "hallo",
  "guten tag",
  "guten morgen",
  "namaste",
  "salut",
  "ola",
  // "привет",
  "здравствуйте",
  "こんにちは",
  "こんばんは",
  "おはよう",
  "おはようございます",
  "やあ",
];

const LIVE_AGENT_PHRASES = [
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
  "transfer to agent",
  "transfer to human",
  "transfer to person",
];

const FOLLOW_UP_ACCEPTANCE =
  /^(okay\s+)?(tell\s+me|yes|yeah|yep|sure|go\s+ahead|please\s+do|do\s+it|ok|okay|continue|proceed)[\s!.?]*$/i;

// Only these three sources are language-agnostic and unambiguous enough to
// skip the LLM classifier entirely. Structural sub-intent (pricing, links,
// contact) and follow-up detection are removed from trusted sources so they
// always fall through to the LLM for multilingual accuracy.
const TRUSTED_RULE_SOURCES = new Set([
  "rules_greeting",
  "rules_live_agent",
  "rules_accidental",
]);

/**
 * True only when the message is a short greeting with no real question attached.
 * Avoids classifying "hello, what are your prices?" as a greeting.
 */
function isPureGreeting(question) {
  const raw = (question || "").trim();
  if (!raw || raw.length > 50) return false;
  if (/\?/.test(raw)) return false;

  const normalized = normalizeGreetingInput(raw);
  if (!normalized) return false;

  if (GREETINGS.includes(normalized)) return true;

  const withoutBang = normalized.replace(/!+$/g, "").trim();
  if (GREETINGS.includes(withoutBang)) return true;

  if (/^h+i+$/i.test(normalized)) return true;
  if (/^he+y+$/i.test(normalized)) return true;
  if (/^hell+o+$/i.test(normalized)) return true;

  return false;
}

function isSimpleGreeting(question) {
  return isPureGreeting(question);
}

function isLiveAgentRequest(question) {
  const normalized = (question || "").toLowerCase().trim();
  return LIVE_AGENT_PHRASES.some((phrase) => normalized.includes(phrase));
}

function classifyStructuralSubIntent(query) {
  const q = (query || "").toLowerCase();

  const wantsInPageList =
    /\b(featured|homepage|home\s*page|main\s*page)\b/.test(q) ||
    /\b(list|show|give\s+me|what\s+are|tell\s+me|share)\b[\s\S]{0,50}\b(products?|items?|options?|styles?|lashes?)\b/.test(
      q
    ) ||
    /\b(urls?|links?)\b/.test(q) &&
      /\b\d{1,2}\s*mm\b/.test(q) &&
      /\b(lash|lashes|product)\b/.test(q) ||
    /\b(all|every|each)\b[\s\S]{0,40}\b(products?|items?|lashes?)\b/.test(q) ||
    /\b(products?|items?|lashes?)\b[\s\S]{0,40}\b(price|prices|cost|pricing)\b/.test(
      q
    ) ||
    /\b(price|prices|cost|pricing)\b[\s\S]{0,40}\b(products?|items?|lashes?)\b/.test(
      q
    ) ||
    /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
      q
    ) ||
    (/\b\d{1,2}\s*mm\b/.test(q) &&
      /\b(options?|styles?|products?|lashes?|share|more)\b/.test(q));

  const wantsContactInfo =
    /\bsocial\s*media\b/.test(q) ||
    /\b(facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest)\b/.test(
      q
    ) ||
    /\b(follow\s+us|find\s+us\s+on)\b/.test(q) ||
    /\b(office\s+hours|business\s+hours|phone\s+number|mailing\s+address)\b/.test(
      q
    ) ||
    (/\b(how\s+(?:do\s+i\s+)?contact|contact\s+(?:info|details|number)|reach\s+us|call\s+us)\b/.test(
      q
    ) &&
      !/\b(refund|return|policy|billing|order|shipping|warranty|cancel|product)\b/.test(
        q
      )) ||
    (/\b(phone|email|e-mail|address|hours|fax|mailing)\b/.test(q) &&
      !/\b(support\s+ticket|submit\s+a\s+ticket|product|refund|policy|billing|order)\b/.test(
        q
      )) ||
    (/\b(give\s+me|show\s+me|what\s+are|list)\b/.test(q) &&
      /\bsocial\b/.test(q)) ||
    isContactIntentQuestion(query);

  const wantsPageLinks =
    !wantsContactInfo &&
    ((/\b(links?|urls?)\b/.test(q) &&
      !/\b(social\s*media|social)\b/.test(q) &&
      /\b(list|show|give|share|send|all|every|how\s+many|more)\b/.test(q)) ||
      (/\b(url|link)\b/.test(q) &&
        /\b\d{1,2}\s*mm\b/.test(q) &&
        /\b(lash|lashes|product|style|collection)\b/.test(q)) ||
      /\bshow\s+me\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      /\b(share|send)\b[\s\S]{0,40}\b(urls?|links?)\b/.test(q) ||
      /\blist\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      (/\b(pages?)\b/.test(q) &&
        /\b(list|show|give|share|all|site|website)\b/.test(q) &&
        !wantsInPageList) ||
      (/\b(collections?)\b/.test(q) &&
        /\b(list|show|all|pages?|links?|share)\b/.test(q) &&
        !/\b(products?|items?|featured|price|prices)\b/.test(q)));

  const hasListHint = /\b(list|show|give\s+me|how\s+many|all\b|top\b)\b/.test(
    q
  );
  const hasProductWord = /\b(products?|items?)\b/.test(q);

  if (wantsInPageList) return SUB_INTENTS.IN_PAGE_LIST;
  if (wantsContactInfo) return SUB_INTENTS.CONTACT_INFO;
  if (wantsPageLinks) return SUB_INTENTS.PAGE_LINKS;
  if (hasListHint && hasProductWord) return SUB_INTENTS.IN_PAGE_LIST;
  return null;
}

function routeFromSubIntent(subIntent) {
  if (
    subIntent === SUB_INTENTS.IN_PAGE_LIST ||
    subIntent === SUB_INTENTS.CONTACT_INFO ||
    subIntent === SUB_INTENTS.PAGE_LINKS
  ) {
    return ROUTES.HYBRID;
  }
  return ROUTES.SEMANTIC_RAG;
}

function formatRecentChatForRouter(messages, limit = 4) {
  if (!messages || messages.length === 0) return "";
  const recent = messages.slice(-limit);
  return recent
    .map((msg) => {
      const role =
        msg.sender_type === "ai" || msg.sender_type === "bot"
          ? "Assistant"
          : "User";
      return `${role}: ${msg.message || ""}`;
    })
    .join("\n");
}

function detectFollowUpAcceptance(question, chatMessages) {
  const q = (question || "").trim();
  if (!FOLLOW_UP_ACCEPTANCE.test(q)) return false;
  if (!chatMessages || chatMessages.length === 0) return false;
  const lastAi = [...chatMessages]
    .reverse()
    .find((m) => m.sender_type === "ai" || m.sender_type === "bot");
  if (!lastAi?.message) return false;
  return /\?|want to know|just ask|tell me if|would you like/i.test(
    lastAi.message
  );
}

function detectUserLanguageFromQuestion(question) {
  const fromScript = detectScriptLanguage(question);
  if (fromScript) return fromScript;

  const fromText = detectLanguageFromText(question);
  return fromText?.language || "en";
}

function buildRouteResult({
  route,
  subIntent = null,
  userLanguage = "en",
  confidence = 1,
  rewrittenQuery = null,
  followUp = false,
  needsRewrite = false,
  rewriteReason = null,
  source = "rules",
}) {
  return {
    route,
    subIntent,
    userLanguage: normalizeLanguageCode(userLanguage) || "en",
    confidence,
    rewrittenQuery,
    followUp,
    needsRewrite,
    rewriteReason,
    source,
  };
}

function applyRuleEngine(question, { chatMessages, conversationState } = {}) {
  const normalizedQuestion = normalizeQueryText(question);
  const userLanguage = detectUserLanguageFromQuestion(normalizedQuestion);
  const stateTopics = topicsFromRagState(conversationState);

  if (isPureGreeting(normalizedQuestion)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.GREETING,
        userLanguage,
        confidence: 0.98,
        source: "rules_greeting",
      }),
    };
  }

  if (isLiveAgentRequest(normalizedQuestion)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.LIVE_AGENT,
        userLanguage,
        confidence: 0.95,
        source: "rules_live_agent",
      }),
    };
  }

  if (isGibberishOrAccidentalMessage(normalizedQuestion)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.ACCIDENTAL,
        userLanguage,
        confidence: 0.95,
        source: "rules_accidental",
      }),
    };
  }

  if (detectFollowUpAcceptance(normalizedQuestion, chatMessages)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.SEMANTIC_RAG,
        userLanguage,
        confidence: 0.9,
        source: "rules_follow_up",
      }),
    };
  }

  const subIntentOnQuestion = classifyStructuralSubIntent(normalizedQuestion);
  if (subIntentOnQuestion) {
    return {
      confident: true,
      result: buildRouteResult({
        route: routeFromSubIntent(subIntentOnQuestion),
        subIntent: subIntentOnQuestion,
        userLanguage,
        confidence: 0.88,
        source: "rules_structural",
      }),
    };
  }

  if (
    detectCatalogFollowUp(normalizedQuestion, chatMessages, {
      stateTopics,
      hasStateCatalogThread: hasCatalogThreadFromState(conversationState),
    })
  ) {
    const { retrievalQuery } = expandQueryForRetrieval(
      normalizedQuestion,
      chatMessages,
      { stateTopics },
    );
    const subIntent = isProductLinkRequest(normalizedQuestion)
      ? SUB_INTENTS.PAGE_LINKS
      : classifyStructuralSubIntent(retrievalQuery);

    if (!subIntent) {
      return { confident: false };
    }

    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.HYBRID,
        subIntent,
        userLanguage,
        confidence: 0.9,
        rewrittenQuery: retrievalQuery !== normalizedQuestion ? retrievalQuery : null,
        followUp: true,
        needsRewrite: retrievalQuery !== normalizedQuestion,
        rewriteReason: retrievalQuery !== normalizedQuestion ? "CATALOG_EXPAND" : null,
        source: "rules_catalog_follow_up",
      }),
    };
  }

  return { confident: false };
}

// Always defer to the LLM unless the rule source is one of the three
// unambiguous cases (greeting / live-agent / gibberish).  Structural
// sub-intent (IN_PAGE_LIST, PAGE_LINKS, CONTACT_INFO) and follow-up
// detection must always be confirmed by the LLM because:
//   1. Regex is English-only; non-English queries need LLM translation.
//   2. Product-name queries ("Premium Drone Kit pricing") won't match
//      patterns that require the word "product" or "item".
//   3. The LLM provides rewrittenQuery so Qdrant keyword search works
//      across all languages.
function shouldDeferToLlmRouter(question, ruleOutcome) {
  if (!ruleOutcome.confident) return true;
  return !TRUSTED_RULE_SOURCES.has(ruleOutcome.result.source);
}

function parseRouterJson(content, question = "") {
  try {
    const parsed = JSON.parse(content || "{}");
    const route = String(parsed.route || "").toUpperCase();
    const validRoutes = Object.values(ROUTES);
    let resolvedRoute = validRoutes.includes(route)
      ? route
      : ROUTES.SEMANTIC_RAG;

    let subIntent = parsed.subIntent
      ? String(parsed.subIntent).toUpperCase()
      : null;
    if (subIntent && !Object.values(SUB_INTENTS).includes(subIntent)) {
      subIntent = null;
    }

    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.7;

    const userLanguage =
      normalizeLanguageCode(parsed.userLanguage) || "en";

    const rewrittenQuery =
      typeof parsed.rewrittenQuery === "string" && parsed.rewrittenQuery.trim()
        ? parsed.rewrittenQuery.trim()
        : null;

    const followUp = Boolean(parsed.followUp);
    const needsRewrite = Boolean(parsed.needsRewrite) || Boolean(rewrittenQuery);
    const rewriteReason =
      typeof parsed.rewriteReason === "string" && parsed.rewriteReason.trim()
        ? parsed.rewriteReason.trim().toUpperCase()
        : rewrittenQuery
          ? "TRANSLATE"
          : null;

    if (
      resolvedRoute === ROUTES.STRUCTURAL ||
      resolvedRoute === ROUTES.HYBRID
    ) {
      if (!subIntent) {
        subIntent = classifyStructuralSubIntent(rewrittenQuery || "");
      }
      if (resolvedRoute === ROUTES.STRUCTURAL) {
        resolvedRoute = ROUTES.HYBRID;
      }
    }

    let finalRoute = resolvedRoute;
    if (confidence < 0.4) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    } else if (confidence < 0.65 && finalRoute !== ROUTES.LIVE_AGENT) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    } else if (
      finalRoute === ROUTES.HYBRID &&
      !subIntent
    ) {
      finalRoute = ROUTES.SEMANTIC_RAG;
    }

    return buildRouteResult({
      route: finalRoute,
      subIntent,
      userLanguage,
      confidence,
      rewrittenQuery,
      followUp,
      needsRewrite,
      rewriteReason,
      source: "llm_router",
    });
  } catch {
    return buildRouteResult({
      route: ROUTES.SEMANTIC_RAG,
      confidence: 0.5,
      source: "llm_router_fallback",
    });
  }
}

async function llmRoute(question, options = {}) {
  const {
    chatHistorySnippet = "",
    conversationStateSnippet = "",
    websiteLanguage = "en",
    openaiClient = null,
    logOpenAIUsage = null,
    routerModel = null,
  } = options;

  let modelName = routerModel;
  let provider = "openai";
  let apiKey = process.env.OPENAI_API_KEY || "";
  let timeoutMs = 30000;

  try {
    const cfg = await getResolvedModelConfig("intent");
    if (!modelName) modelName = cfg.model;
    if (isSupportedChatProvider(cfg.provider)) {
      provider = cfg.provider;
      apiKey = cfg.apiKey || apiKey;
      timeoutMs = cfg.timeoutMs || timeoutMs;
    }
  } catch {
    if (!modelName) {
      modelName = process.env.OPENAI_ROUTER_MODEL || ROUTER_MODEL;
    }
  }

  const systemPrompt = `You are a query router for a multilingual customer-support chatbot.

Classify the visitor message into exactly one route:
- GREETING: simple hello/hi with no real question
- LIVE_AGENT: wants a human agent, representative, or live support
- ACCIDENTAL: random characters, keyboard mash, or test input with no real meaning
- ACKNOWLEDGEMENT: pure social acknowledgement with NO new question or intent (e.g. "ok", "thanks", "got it", "understood", "great", "merci", "ありがとう", "धन्यवाद", "gracias"). Use chat history to resolve ambiguity — "ok" after a bot offer/question = SEMANTIC_RAG (follow-up acceptance), "ok"/"thanks" after a bot answer = ACKNOWLEDGEMENT. ANY new question, request, or new topic = SEMANTIC_RAG, not ACKNOWLEDGEMENT.
- HYBRID: ONLY when the user clearly wants a navigational list (pages/URLs/collections), homepage product catalog with prices, or contact/social profiles
- SEMANTIC_RAG: factual Q&A about the business — DEFAULT when unsure

IMPORTANT: Prefer SEMANTIC_RAG for pricing, features, policies, how-to, and general questions even if they contain words like "show" or "list". Only use HYBRID for explicit listing/navigation/contact requests. Real questions in any language (Japanese, Chinese, Russian, Spanish, etc.) must be SEMANTIC_RAG, not ACCIDENTAL.

For HYBRID, set subIntent to one of: IN_PAGE_LIST, CONTACT_INFO, PAGE_LINKS.
- CONTACT_INFO: phone, email, address, hours, social media profiles — in ANY language (e.g. Japanese 連絡先, お問い合わせ, 電話番号)
- IN_PAGE_LIST: product catalog with prices/sizes
- PAGE_LINKS: list of site pages or collection URLs

Also classify business intent in ANY language:
- isIdentityQuestion: true when the user asks who you are or to introduce yourself/the company (e.g. "who are you", "describe yourself", "介绍一下你自己", "自己紹介してください", "qui êtes-vous")
- isBusinessQuestion: true for products, services, pricing, policies, company info, or any support question about the business
- isTrulyOffTopic: true ONLY for unrelated general knowledge (weather, jokes, sports, recipes, crypto prices, politics) — NOT for business questions even in non-English

If isIdentityQuestion or isBusinessQuestion is true, route MUST be SEMANTIC_RAG and isTrulyOffTopic MUST be false.

Detect userLanguage: ISO 639-1 code for the language the visitor WROTE IN (e.g. en, es, fr, de, zh, ja, ko, ar, hi, ru, pt, th, vi, tr). Do NOT guess language from script alone.

Conversation state summarizes the active topic and entities from prior turns. Use it to resolve short follow-ups, pronouns, and elliptical questions (e.g. "how much?", "send the link", "what about pricing?").

When the message depends on conversation state OR userLanguage differs from website language (${websiteLanguage}), provide rewrittenQuery: a self-contained search query in ${websiteLanguage} suitable for embedding similarity search and keyword matching. Preserve product names, brand names, numbers, and measurements. If the message is already a clear standalone query in ${websiteLanguage}, rewrittenQuery can be null.

Set followUp=true when the message continues the same topic from conversation state.
Set needsRewrite=true when rewrittenQuery is provided or the message cannot be searched without resolving context.
Set rewriteReason to one of: PRONOUN, ELLIPSIS, TRANSLATE, CATALOG_EXPAND, NONE.

Respond with JSON only:
{
  "route": "SEMANTIC_RAG",
  "subIntent": null,
  "userLanguage": "en",
  "confidence": 0.85,
  "rewrittenQuery": null,
  "followUp": false,
  "needsRewrite": false,
  "rewriteReason": "NONE",
  "isTrulyOffTopic": false
}`;

  const userContentParts = [`Website language: ${websiteLanguage}`];

  if (conversationStateSnippet) {
    userContentParts.push(`Conversation state:\n${conversationStateSnippet}`);
  } else {
    userContentParts.push("Conversation state: (none)");
  }

  if (chatHistorySnippet) {
    userContentParts.push(`Recent conversation:\n${chatHistorySnippet}`);
  }

  userContentParts.push(`User message: ${question}`);
  const userContent = userContentParts.join("\n\n");

  try {
    let content;
    let usage = null;

    // Prefer injected OpenAI client when provider is openai (tests / callers)
    if (provider === "openai" && openaiClient) {
      const response = await openaiClient.chat.completions.create({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      });
      content = response.choices[0]?.message?.content;
      usage = response.usage || null;
    } else {
      if (!apiKey) {
        throw new Error(`Missing API key for intent provider: ${provider}`);
      }
      const result = await providerChatComplete({
        provider,
        model: modelName,
        apiKey,
        timeoutMs,
        system: systemPrompt,
        prompt: userContent,
        temperature: 0,
      });
      content = result.text;
      usage = result.usage;
    }

    console.log("[QueryRouter] LLM routing response:", {
      question: question.substring(0, 80),
      provider,
      model: modelName,
      content,
    });
    if (logOpenAIUsage && usage) {
      try {
        await logOpenAIUsage({
          usage,
          modelName,
          type: "intent",
        });
      } catch (logError) {
        console.warn(
          `[QueryRouter] Error logging routing usage: ${logError.message}`
        );
      }
    }

    console.log("parsed content data check : ",parseRouterJson(content));

    return parseRouterJson(content);
  } catch (error) {
    console.error("[QueryRouter] LLM routing failed:", error.message);
    return buildRouteResult({
      route: ROUTES.SEMANTIC_RAG,
      confidence: 0.5,
      source: "llm_router_error",
    });
  }
}

/**
 * Route a visitor query: fast rules first, then GPT nano fallback.
 */
async function routeQuery(question, options = {}) {
  const {
    chatMessages = [],
    conversationState = null,
    websiteLanguage = "en",
    openaiClient = null,
    logOpenAIUsage,
    routerModel = null,
  } = options;

  const ruleOutcome = applyRuleEngine(question, {
    chatMessages,
    conversationState,
    websiteLanguage,
  });

  console.log("[QueryRouter] Rule engine outcome:", {
    question: question.substring(0, 80),
    route: ruleOutcome.result?.route || null,
  });

  console.log("shouldDeferToLlmRouter:", shouldDeferToLlmRouter(question, ruleOutcome));

  if (!shouldDeferToLlmRouter(question, ruleOutcome)) {
    return ruleOutcome.result;
  }

  const conversationStateSnippet = formatStateForRouter(conversationState);
  const chatHistorySnippet = conversationStateSnippet
    ? ""
    : formatRecentChatForRouter(chatMessages);

  console.log("conversation state for LLM routing:", conversationStateSnippet);
  console.log("chat history snippet for LLM routing:", chatHistorySnippet);

  console.log(
    `[QueryRouter] LLM routing (rules deferred: ${ruleOutcome.confident ? ruleOutcome.result?.source : "no_match"}) for: ${question.substring(0, 80)}`
  );

  return llmRoute(question, {
    chatHistorySnippet,
    conversationStateSnippet,
    websiteLanguage,
    openaiClient,
    logOpenAIUsage,
    routerModel,
  });
}

function isRagRoute(route) {
  return route === ROUTES.SEMANTIC_RAG || route === ROUTES.HYBRID;
}

module.exports = {
  ROUTES,
  SUB_INTENTS,
  routeQuery,
  isRagRoute,
  classifyStructuralSubIntent,
  isSimpleGreeting,
  isPureGreeting,
  isLiveAgentRequest,
  formatRecentChatForRouter,
};
