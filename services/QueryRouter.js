require("dotenv").config();
const { OpenAI } = require("openai");
const { normalizeLanguageCode, detectLanguageFromText } = require("../utils/websiteLanguage");

const ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || "gpt-4.1-nano";

const ROUTES = {
  GREETING: "GREETING",
  LIVE_AGENT: "LIVE_AGENT",
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
  "bonjour",
  "ciao",
  "hallo",
  "namaste",
  "salut",
  "ola",
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

function isSimpleGreeting(question) {
  const normalized = (question || "").toLowerCase().trim();
  return GREETINGS.some(
    (greeting) =>
      normalized === greeting ||
      normalized.startsWith(`${greeting} `) ||
      normalized === `${greeting}!`
  );
}

function isLiveAgentRequest(question) {
  const normalized = (question || "").toLowerCase().trim();
  return LIVE_AGENT_PHRASES.some((phrase) => normalized.includes(phrase));
}

function classifyStructuralSubIntent(query) {
  const q = (query || "").toLowerCase();

  const wantsInPageList =
    /\b(featured|homepage|home\s*page|main\s*page)\b/.test(q) ||
    /\b(list|show|give\s+me|what\s+are|tell\s+me)\b[\s\S]{0,50}\b(products?|items?)\b/.test(
      q
    ) ||
    /\b(all|every|each)\b[\s\S]{0,40}\b(products?|items?)\b/.test(q) ||
    /\b(products?|items?)\b[\s\S]{0,40}\b(price|prices|cost|pricing)\b/.test(
      q
    ) ||
    /\b(price|prices|cost|pricing)\b[\s\S]{0,40}\b(products?|items?)\b/.test(
      q
    ) ||
    /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
      q
    );

  const wantsContactInfo =
    /\bsocial\s*media\b/.test(q) ||
    /\b(facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest)\b/.test(
      q
    ) ||
    /\b(follow\s+us|find\s+us\s+on)\b/.test(q) ||
    /\b(office\s+hours|business\s+hours|phone\s+number|mailing\s+address)\b/.test(
      q
    ) ||
    (/\b(phone|email|e-mail|address|contact|hours|fax|call\s+us|reach\s+us|mailing)\b/.test(
      q
    ) &&
      !/\b(support\s+ticket|submit\s+a\s+ticket|product)\b/.test(q)) ||
    (/\b(give\s+me|show\s+me|what\s+are|list)\b/.test(q) &&
      /\bsocial\b/.test(q));

  const wantsPageLinks =
    !wantsContactInfo &&
    ((/\b(links?|urls?)\b/.test(q) && !/\b(social\s*media|social)\b/.test(q)) ||
      /\bshow\s+me\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      /\blist\b[\s\S]{0,40}\b(pages?|links?|urls?)\b/.test(q) ||
      (/\b(pages?)\b/.test(q) && !wantsInPageList) ||
      (/\b(collections?)\b/.test(q) &&
        !/\b(products?|items?|featured|price|prices)\b/.test(q)));

  const hasListHint = /\b(list|show|give\s+me|how\s+many|all\b|top\b)\b/.test(
    q
  );
  const hasProductWord = /\b(products?|items?)\b/.test(q);

  if (wantsInPageList) return SUB_INTENTS.IN_PAGE_LIST;
  if (wantsContactInfo) return SUB_INTENTS.CONTACT_INFO;
  if (wantsPageLinks) return SUB_INTENTS.PAGE_LINKS;
  if (hasListHint && hasProductWord) return SUB_INTENTS.IN_PAGE_LIST;
  if (hasListHint) return SUB_INTENTS.PAGE_LINKS;
  return null;
}

function routeFromSubIntent(subIntent) {
  if (subIntent === SUB_INTENTS.IN_PAGE_LIST || subIntent === SUB_INTENTS.CONTACT_INFO) {
    return ROUTES.HYBRID;
  }
  if (subIntent === SUB_INTENTS.PAGE_LINKS) {
    return ROUTES.STRUCTURAL;
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
  const fromText = detectLanguageFromText(question);
  return fromText?.language || "en";
}

function buildRouteResult({
  route,
  subIntent = null,
  userLanguage = "en",
  confidence = 1,
  rewrittenQuery = null,
  source = "rules",
}) {
  return {
    route,
    subIntent,
    userLanguage: normalizeLanguageCode(userLanguage) || "en",
    confidence,
    rewrittenQuery,
    source,
  };
}

function applyRuleEngine(question, { chatMessages } = {}) {
  const userLanguage = detectUserLanguageFromQuestion(question);

  if (isSimpleGreeting(question)) {
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

  if (isLiveAgentRequest(question)) {
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

  if (detectFollowUpAcceptance(question, chatMessages)) {
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

  const subIntent = classifyStructuralSubIntent(question);
  if (subIntent) {
    const route = routeFromSubIntent(subIntent);
    return {
      confident: true,
      result: buildRouteResult({
        route,
        subIntent,
        userLanguage,
        confidence: 0.88,
        source: "rules_structural",
      }),
    };
  }

  return { confident: false };
}

function parseRouterJson(content) {
  try {
    const parsed = JSON.parse(content || "{}");
    const route = String(parsed.route || "").toUpperCase();
    const validRoutes = Object.values(ROUTES);
    const resolvedRoute = validRoutes.includes(route)
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

    if (
      resolvedRoute === ROUTES.STRUCTURAL ||
      resolvedRoute === ROUTES.HYBRID
    ) {
      if (!subIntent) {
        subIntent = classifyStructuralSubIntent(
          rewrittenQuery || parsed.originalQuery || ""
        );
      }
    }

    let finalRoute = resolvedRoute;
    if (confidence < 0.4) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    } else if (confidence < 0.6 && finalRoute !== ROUTES.LIVE_AGENT) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    }

    return buildRouteResult({
      route: finalRoute,
      subIntent,
      userLanguage,
      confidence,
      rewrittenQuery,
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
    websiteLanguage = "en",
    openaiClient = null,
  } = options;

  const client =
    openaiClient ||
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const systemPrompt = `You are a query router for a multilingual customer-support chatbot.

Classify the visitor message into exactly one route:
- GREETING: simple hello/hi with no real question
- LIVE_AGENT: wants a human agent, representative, or live support
- STRUCTURAL: needs keyword/page listing (PAGE_LINKS only — distinct pages or URLs)
- HYBRID: needs both keyword search and semantic search (IN_PAGE_LIST or CONTACT_INFO)
- SEMANTIC_RAG: factual Q&A about the business (default)

For STRUCTURAL or HYBRID, set subIntent to one of: IN_PAGE_LIST, CONTACT_INFO, PAGE_LINKS.

Detect userLanguage: ISO 639-1 code for the language the visitor wrote in (e.g. en, de, hi).

If route is STRUCTURAL or HYBRID and userLanguage differs from website language, provide rewrittenQuery: search keywords/phrases in the website language (${websiteLanguage}) for keyword matching. Otherwise rewrittenQuery can be null.

Use conversation history for short follow-ups like "yes", "tell me", "what about pricing?".

Respond with JSON only:
{
  "route": "SEMANTIC_RAG",
  "subIntent": null,
  "userLanguage": "en",
  "confidence": 0.85,
  "rewrittenQuery": null
}`;

  const userContent = [
    `Website language: ${websiteLanguage}`,
    chatHistorySnippet
      ? `Recent conversation:\n${chatHistorySnippet}`
      : "Recent conversation: (none)",
    `User message: ${question}`,
  ].join("\n\n");

  try {
    const response = await client.chat.completions.create({
      model: ROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    return parseRouterJson(response.choices[0]?.message?.content);
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
    websiteLanguage = "en",
    openaiClient = null,
  } = options;

  const ruleOutcome = applyRuleEngine(question, {
    chatMessages,
    websiteLanguage,
  });

  if (ruleOutcome.confident) {
    return ruleOutcome.result;
  }

  const chatHistorySnippet = formatRecentChatForRouter(chatMessages);
  return llmRoute(question, {
    chatHistorySnippet,
    websiteLanguage,
    openaiClient,
  });
}

module.exports = {
  ROUTES,
  SUB_INTENTS,
  routeQuery,
  classifyStructuralSubIntent,
  isSimpleGreeting,
  isLiveAgentRequest,
  formatRecentChatForRouter,
};
