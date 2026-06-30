require("dotenv").config();
const { OpenAI } = require("openai");
const { normalizeLanguageCode, detectLanguageFromText } = require("../utils/websiteLanguage");
const {
  detectCatalogFollowUp,
  isProductLinkRequest,
  expandQueryForRetrieval,
} = require("../utils/queryContextExpansion");
const { normalizeQueryText } = require("../utils/queryNormalization");

const CATALOG_PRODUCT_WORDS =
  "(?:products?|items?|options?|styles?|lash(?:es)?)";

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
    new RegExp(
      `\\b(list|show|give\\s+me|what\\s+are|tell\\s+me|share)\\b[\\s\\S]{0,50}\\b${CATALOG_PRODUCT_WORDS}\\b`
    ).test(q) ||
    /\b(urls?|links?)\b/.test(q) &&
      /\b\d{1,2}(?:-\d{1,2})?mm\b/.test(q) &&
      /\b(lash(?:es)?|product)\b/.test(q) ||
    new RegExp(
      `\\b(all|every|each)\\b[\\s\\S]{0,40}\\b${CATALOG_PRODUCT_WORDS}\\b`
    ).test(q) ||
    new RegExp(
      `\\b${CATALOG_PRODUCT_WORDS}\\b[\\s\\S]{0,40}\\b(price|prices|cost|pricing)\\b`
    ).test(q) ||
    new RegExp(
      `\\b(price|prices|cost|pricing)\\b[\\s\\S]{0,40}\\b${CATALOG_PRODUCT_WORDS}\\b`
    ).test(q) ||
    /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
      q
    ) ||
    (/\b\d{1,2}(?:-\d{1,2})?mm\b/.test(q) &&
      new RegExp(
        `\\b(options?|styles?|products?|lash(?:es)?|share|more)\\b`
      ).test(q));

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
      /\bsocial\b/.test(q));

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
  const normalizedQuestion = normalizeQueryText(question);
  const userLanguage = detectUserLanguageFromQuestion(normalizedQuestion);

  if (isSimpleGreeting(normalizedQuestion)) {
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

  if (detectCatalogFollowUp(normalizedQuestion, chatMessages)) {
    const { retrievalQuery } = expandQueryForRetrieval(
      normalizedQuestion,
      chatMessages
    );
    const subIntent = isProductLinkRequest(normalizedQuestion)
      ? SUB_INTENTS.PAGE_LINKS
      : classifyStructuralSubIntent(retrievalQuery) || SUB_INTENTS.IN_PAGE_LIST;
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.HYBRID,
        subIntent,
        userLanguage,
        confidence: 0.9,
        rewrittenQuery: retrievalQuery !== normalizedQuestion ? retrievalQuery : null,
        source: "rules_catalog_follow_up",
      }),
    };
  }

  const subIntent = classifyStructuralSubIntent(normalizedQuestion);
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
          rewrittenQuery || question
        );
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
- HYBRID: ONLY when the user clearly wants a navigational list (pages/URLs/collections), homepage product catalog with prices, or contact/social profiles
- SEMANTIC_RAG: factual Q&A about the business — DEFAULT when unsure

IMPORTANT: Prefer SEMANTIC_RAG for pricing, features, policies, how-to, and general questions even if they contain words like "show" or "list". Only use HYBRID for explicit listing/navigation/contact requests.

For HYBRID, set subIntent to one of: IN_PAGE_LIST, CONTACT_INFO, PAGE_LINKS.

Detect userLanguage: ISO 639-1 code for the language the visitor wrote in (e.g. en, de, hi).

If route is HYBRID and userLanguage differs from website language, provide rewrittenQuery: search keywords/phrases in the website language (${websiteLanguage}) for keyword matching. Otherwise rewrittenQuery can be null.

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
