require("dotenv").config();
const { getResolvedModelConfig } = require("./aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("./providerChatComplete");
const {
  normalizeLanguageCode,
  detectLanguageFromText,
} = require("../utils/websiteLanguage");
const {
  detectCatalogFollowUp,
  isProductLinkRequest,
  expandQueryForRetrieval,
} = require("../utils/queryContextExpansion");
const {
  formatStateForRouter,
  topicsFromRagState,
  hasCatalogThreadFromState,
  isAwaitingFollowUp,
  normalizeRagState,
} = require("./conversationStateService");
const { normalizeQueryText } = require("../utils/queryNormalization");
const { isContactIntentQuestion } = require("../utils/contactIntentDetection");
const {
  detectMultiEntityFromRules,
  parseProductListFromAssistantText,
} = require("./retrieval/entityResolution");
const {
  MULTI_ENTITY_MODES,
  normalizeMultiEntityMode,
} = require("./retrieval/multiEntityModes");
const {
  normalizeGreetingInput,
  isGibberishOrAccidentalMessage,
  detectScriptLanguage,
} = require("./LightweightResponseService");
const {
  isCompanyIdentityQuestion,
} = require("../utils/queryOnTopicDetection");

const { userIntentPrompt } = require("../prompts/intent-detection-prompt.js");
const {
  normalizeRecall,
  parseRecallIntent,
  resolveRecallContract,
} = require("./conversationRecallService");

const ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || "gpt-4.1-nano";

const ROUTES = {
  GREETING: "GREETING",
  LIVE_AGENT: "LIVE_AGENT",
  ACCIDENTAL: "ACCIDENTAL",
  ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT",
  STRUCTURAL: "STRUCTURAL",
  SEMANTIC_RAG: "SEMANTIC_RAG",
  HYBRID: "HYBRID",
  CONVERSATION_RECALL: "CONVERSATION_RECALL",
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

/**
 * Short acceptance of a soft offer / prior recommendation.
 * Covers pure tokens ("ok", "yes") and incomplete accepts ("yeah i want", "ok go for it").
 */
const FOLLOW_UP_ACCEPTANCE =
  /^(?:okay\s+|ok\s+)?(?:tell\s+me|yes|yeah|yep|yup|sure|go\s+ahead|go\s+for\s+it|please\s+do|do\s+it|ok|okay|continue|proceed|please|alright|all\s+right)(?:[\s,]+(?:i\s+want(?:\s+it)?|i\s+do|please|go\s+ahead|go\s+for\s+it|do\s+it|do\s+that|sounds\s+good|that\s+works|let'?s\s+do\s+it))?[\s!.?]*$/i;

/** Pure thanks / closure — stay on ACKNOWLEDGEMENT even after a soft offer. */
const PURE_THANKS =
  /^(thanks|thank\s+you|thx|ty|got\s+it|understood|perfect|great|awesome|cool|merci|gracias|ありがとう|धन्यवाद)[\s!.]*$/i;

/**
 * Soft offers that invite the user to continue (HTML stripped before match).
 * Used to set ragState.awaiting and to accept short affirmatives as follow-ups.
 */
const SOFT_OFFER_PATTERN =
  /let me know|further details?|more details?|further information|more information|feel free|anything else|any other questions?|if you (?:need|want|have|d like)|want to know(?:\s+more)?|just ask|tell me if|would you like|need (?:any )?more|happy to (?:help|share|provide|tell)|here if you|more about|should you (?:need|want)|don'?t hesitate/i;

// Only these sources are unambiguous enough to skip the LLM classifier.
// Follow-up acceptance is included when awaitingFollowUp / soft-offer is explicit.
const TRUSTED_RULE_SOURCES = new Set([
  "rules_identity",
  "rules_greeting",
  "rules_live_agent",
  "rules_accidental",
  "rules_follow_up_acceptance",
  "rules_category_navigation",
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

/**
 * Narrow catalog-structure ask (navbar / collections / categories list).
 * Does not match product recommendations like "suggest lip oils and lip scrubs".
 */
function isCategoryNavigationRequest(question) {
  const q = String(question || "").toLowerCase();
  const hasNavigationNoun =
    /\b(collections?|categor(?:y|ies)|catalog(?:ue)?|navbar|navigation|menu|departments?)\b/.test(
      q,
    );
  if (!hasNavigationNoun) return false;

  // Product asks about items inside a collection stay on SEMANTIC_RAG / IN_PAGE_LIST.
  if (/\b(products?|items?)\b/.test(q) && !/\bproduct\s+categor(?:y|ies)\b/.test(q)) {
    return false;
  }

  return (
    /\b(list|show|display|give|share|send|all|every|available)\b/.test(q) ||
    /\bwhat\b[\s\S]{0,45}\b(?:collections?|categor(?:y|ies)|catalog(?:ue)?|menu|departments?)\b/.test(
      q,
    ) ||
    /\bwhich\b[\s\S]{0,45}\b(?:collections?|categor(?:y|ies)|departments?)\b/.test(
      q,
    ) ||
    /\b(?:collections?|categor(?:y|ies)|catalog(?:ue)?|menu|departments?)\b[\s\S]{0,30}\b(?:do\s+you\s+have|are\s+there|are\s+available)\b/.test(
      q,
    )
  );
}

function classifyStructuralSubIntent(query) {
  const q = (query || "").toLowerCase();

  const wantsInPageList =
    /\b(featured|homepage|home\s*page|main\s*page)\b/.test(q) ||
    /\b(list|show|give\s+me|what\s+are|tell\s+me|share)\b[\s\S]{0,50}\b(products?|items?|options?|styles?|lashes?)\b/.test(
      q,
    ) ||
    (/\b(urls?|links?)\b/.test(q) &&
      /\b\d{1,2}\s*mm\b/.test(q) &&
      /\b(lash|lashes|product)\b/.test(q)) ||
    /\b(all|every|each)\b[\s\S]{0,40}\b(products?|items?|lashes?)\b/.test(q) ||
    /\b(products?|items?|lashes?)\b[\s\S]{0,40}\b(price|prices|cost|pricing)\b/.test(
      q,
    ) ||
    /\b(price|prices|cost|pricing)\b[\s\S]{0,40}\b(products?|items?|lashes?)\b/.test(
      q,
    ) ||
    /\bwhat(?:'s| is)\s+on\s+(?:the\s+|your\s+)?(?:homepage|home\s*page|main\s*page)\b/.test(
      q,
    ) ||
    (/\b\d{1,2}\s*mm\b/.test(q) &&
      /\b(options?|styles?|products?|lashes?|share|more)\b/.test(q));

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
    q,
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

function stripHtmlForOfferDetection(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastAssistantMessage(chatMessages) {
  if (!chatMessages || chatMessages.length === 0) return "";
  const lastAi = [...chatMessages]
    .reverse()
    .find((m) => m.sender_type === "ai" || m.sender_type === "bot");
  return lastAi?.message || "";
}

/**
 * True when the assistant reply invites more detail / continuation.
 */
function detectSoftOffer(assistantMessage) {
  const plain = stripHtmlForOfferDetection(assistantMessage);
  if (!plain || plain.length < 8) return false;
  return SOFT_OFFER_PATTERN.test(plain);
}

function isShortAffirmative(question) {
  const q = (question || "").trim();
  if (!q || q.length > 48) return false;
  if (PURE_THANKS.test(q)) return false;
  return FOLLOW_UP_ACCEPTANCE.test(q);
}

function isPureThanks(question) {
  return PURE_THANKS.test((question || "").trim());
}

/**
 * ragState-only rewrite fallback (prior standalone query / topic / product).
 */
function rewriteFromConversationState(conversationState) {
  const state = normalizeRagState(conversationState);
  return (
    (state.lastStandaloneQuery && state.lastStandaloneQuery.trim()) ||
    (state.topic && state.topic.trim()) ||
    (state.entities?.product && String(state.entities.product).trim()) ||
    (Array.isArray(state.listedProducts) &&
      state.listedProducts[0] &&
      String(state.listedProducts[0]).trim()) ||
    null
  );
}

/**
 * Last non-trivial user turn (skips greetings / thanks / short accepts).
 */
function getLastMeaningfulUserQuery(chatMessages = []) {
  const messages = [...(chatMessages || [])].reverse();
  for (const msg of messages) {
    const sender = msg.sender_type || msg.role || "";
    if (sender === "ai" || sender === "bot" || sender === "assistant") {
      continue;
    }
    const text = String(msg.message || msg.content || "").trim();
    if (!text || text.length < 3) continue;
    if (
      isShortAffirmative(text) ||
      isPureThanks(text) ||
      isPureGreeting(text)
    ) {
      continue;
    }
    return text;
  }
  return null;
}

/**
 * Product / recommendation named in the last assistant reply (intent-layer history).
 */
function extractRecommendedProductFromAssistant(assistantMessage) {
  if (!assistantMessage) return null;

  const fromList = parseProductListFromAssistantText(assistantMessage);
  if (fromList.length >= 1) return fromList[0];

  const plain = stripHtmlForOfferDetection(assistantMessage);
  if (!plain) return null;

  const patterns = [
    /(?:we\s+)?(?:suggest|recommend|recommending)\s+(?:our\s+|the\s+)?([^.!?]{4,120})/i,
    /(?:go\s+with|choose)\s+(?:our\s+|the\s+)?([^.!?]{4,120})/i,
  ];

  for (const re of patterns) {
    const match = plain.match(re);
    if (!match?.[1]) continue;
    let name = match[1]
      .replace(/\s+(?:this|it|at)\b[\s\S]*$/i, "")
      .replace(/[,;:]+$/g, "")
      .trim();
    if (name.length >= 3 && name.length <= 120) return name;
  }

  return null;
}

/**
 * Intent-layer rewrite for follow-up acceptance using conversation state + chat history.
 * Prefers a standalone product/topic over the user's fragment ("yeah i want").
 */
function rewriteFollowUpFromIntentContext({
  conversationState = null,
  chatMessages = [],
  llmRewrittenQuery = null,
} = {}) {
  const llm =
    typeof llmRewrittenQuery === "string" ? llmRewrittenQuery.trim() : "";
  // Trust LLM rewrite only when it is already a standalone search query.
  if (
    llm &&
    llm.length > 8 &&
    !isShortAffirmative(llm) &&
    !isPureThanks(llm) &&
    !FOLLOW_UP_ACCEPTANCE.test(llm)
  ) {
    return llm;
  }

  const fromState = rewriteFromConversationState(conversationState);
  const lastAssistant = getLastAssistantMessage(chatMessages);
  const productFromHistory =
    extractRecommendedProductFromAssistant(lastAssistant);
  const lastUserQuery = getLastMeaningfulUserQuery(chatMessages);

  // After a concrete recommendation, product name is the best retrieval query.
  if (productFromHistory) return productFromHistory;
  if (fromState) return fromState;
  if (lastUserQuery) return lastUserQuery;
  return llm || null;
}

/**
 * Force SEMANTIC_RAG + intent-layer rewrite when the user accepts a soft offer / awaiting follow-up.
 */
function applyFollowUpAcceptanceOverride(
  result,
  question,
  { chatMessages = [], conversationState = null } = {},
) {
  if (!isShortAffirmative(question)) return result;
  if (isPureThanks(question)) return result;

  const awaiting = isAwaitingFollowUp(conversationState);
  const lastOffer = detectSoftOffer(getLastAssistantMessage(chatMessages));
  if (!awaiting && !lastOffer) return result;

  const rewrittenQuery = rewriteFollowUpFromIntentContext({
    conversationState,
    chatMessages,
    llmRewrittenQuery: result?.rewrittenQuery,
  });

  if (rewrittenQuery) {
    console.log(
      `[QueryRouter] Follow-up rewrite (intent): "${question}" → "${rewrittenQuery}"`,
    );
  }

  return buildRouteResult({
    route: ROUTES.SEMANTIC_RAG,
    subIntent: result?.subIntent || null,
    userLanguage: result?.userLanguage || "en",
    confidence: Math.max(result?.confidence || 0, 0.92),
    rewrittenQuery,
    lexicalTerms: result?.lexicalTerms,
    constraints: result?.constraints,
    multiEntityMode: result?.multiEntityMode,
    rawEntities: result?.rawEntities,
    followUp: true,
    needsRewrite: Boolean(rewrittenQuery),
    rewriteReason: rewrittenQuery
      ? result?.rewriteReason && result.rewriteReason !== "NONE"
        ? result.rewriteReason
        : "ELLIPSIS"
      : null,
    source:
      result?.source && String(result.source).startsWith("llm")
        ? "llm_router_follow_up_override"
        : "rules_follow_up_acceptance",
  });
}

function applyConversationRecallContract(
  result,
  question,
  chatMessages = [],
  recallInventory = null,
) {
  if (result?.route !== ROUTES.CONVERSATION_RECALL) return result;

  const resolved = resolveRecallContract(result.recall, {
    chatMessages,
    currentQuestion: question,
    recallInventory,
  });

  if (!resolved.ok) {
    return buildRouteResult({
      route: ROUTES.SEMANTIC_RAG,
      userLanguage: result.userLanguage || "en",
      confidence: result.confidence || 0.5,
      source: "conversation_recall_unresolved",
    });
  }

  return buildRouteResult({
    route: ROUTES.CONVERSATION_RECALL,
    userLanguage: result.userLanguage || "en",
    confidence: result.confidence || 0.9,
    recall: resolved.recall,
    source: result.source || "llm_router",
  });
}

function detectFollowUpAcceptance(question, chatMessages, conversationState) {
  if (!isShortAffirmative(question)) return false;
  if (isAwaitingFollowUp(conversationState)) return true;
  return detectSoftOffer(getLastAssistantMessage(chatMessages));
}

function detectUserLanguageFromQuestion(question) {
  const fromScript = detectScriptLanguage(question);
  if (fromScript) return fromScript;

  const fromText = detectLanguageFromText(question);
  return fromText?.language || "en";
}

const CONSTRAINT_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
]);
const CONSTRAINT_SOURCES = new Set(["user", "inferred", "rewrite", "history"]);

/**
 * Normalize raw LLM constraint objects. Every constraint always carries
 * field/value/operator/confidence/source — defaults are applied here so
 * downstream consumers (constraint→facet mapper) never see partial shapes.
 * Field vocabulary is intentionally NOT restricted to a fixed list.
 */
function normalizeConstraints(rawConstraints) {
  if (!Array.isArray(rawConstraints)) return [];

  const constraints = [];
  for (const raw of rawConstraints) {
    if (!raw || typeof raw !== "object") continue;

    const field = typeof raw.field === "string" ? raw.field.trim() : "";
    const value =
      raw.value === null || raw.value === undefined
        ? ""
        : String(raw.value).trim();
    if (!field || !value) continue;

    const operator = CONSTRAINT_OPERATORS.has(
      String(raw.operator || "").toLowerCase(),
    )
      ? String(raw.operator).toLowerCase()
      : "eq";

    const confidence =
      typeof raw.confidence === "number"
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.7;

    const source = CONSTRAINT_SOURCES.has(
      String(raw.source || "").toLowerCase(),
    )
      ? String(raw.source).toLowerCase()
      : "user";

    constraints.push({ field, value, operator, confidence, source });
  }

  return constraints.slice(0, 12);
}

function buildRouteResult({
  route,
  subIntent = null,
  userLanguage = "en",
  confidence = 1,
  rewrittenQuery = null,
  lexicalTerms = [],
  constraints = [],
  multiEntityMode = null,
  rawEntities = [],
  followUp = false,
  needsRewrite = false,
  rewriteReason = null,
  isIdentityQuestion = false,
  isBusinessQuestion = false,
  isTrulyOffTopic = false,
  recall = null,
  source = "rules",
}) {
  const normalizedRaw = Array.isArray(rawEntities)
    ? rawEntities
        .map((e) => String(e || "").trim())
        .filter((e) => e.length > 1)
        .slice(0, 5)
    : [];

  return {
    route,
    subIntent,
    userLanguage: normalizeLanguageCode(userLanguage) || "en",
    confidence,
    rewrittenQuery,
    lexicalTerms: Array.isArray(lexicalTerms) ? lexicalTerms.slice(0, 8) : [],
    constraints: normalizeConstraints(constraints),
    multiEntityMode: normalizeMultiEntityMode(multiEntityMode),
    rawEntities: normalizedRaw,
    followUp,
    needsRewrite,
    rewriteReason,
    isIdentityQuestion,
    isBusinessQuestion,
    isTrulyOffTopic,
    recall: recall?.reference
      ? parseRecallIntent(recall)
      : normalizeRecall(recall),
    source,
  };
}

function applyRuleEngine(question, { chatMessages, conversationState } = {}) {
  const normalizedQuestion = normalizeQueryText(question);
  const userLanguage = detectUserLanguageFromQuestion(normalizedQuestion);
  const stateTopics = topicsFromRagState(conversationState);

  // Identity requests are meaningful business questions. Handle the common
  // English forms deterministically so a small router model cannot mistake
  // them for a greeting or acknowledgement.
  if (isCompanyIdentityQuestion(normalizedQuestion)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.SEMANTIC_RAG,
        userLanguage,
        confidence: 0.99,
        rewrittenQuery:
          "Company overview, products, services, and customer support assistant role",
        lexicalTerms: [
          "company overview",
          "products",
          "services",
          "customer support",
        ],
        needsRewrite: true,
        rewriteReason: "NORMALIZE",
        isIdentityQuestion: true,
        isBusinessQuestion: true,
        source: "rules_identity",
      }),
    };
  }

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

  // if (isLiveAgentRequest(normalizedQuestion)) {
  //   return {
  //     confident: true,
  //     result: buildRouteResult({
  //       route: ROUTES.LIVE_AGENT,
  //       userLanguage,
  //       confidence: 0.95,
  //       source: "rules_live_agent",
  //     }),
  //   };
  // }

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

  if (
    detectFollowUpAcceptance(
      normalizedQuestion,
      chatMessages,
      conversationState,
    )
  ) {
    const rewrittenQuery = rewriteFollowUpFromIntentContext({
      conversationState,
      chatMessages,
    });
    if (rewrittenQuery) {
      console.log(
        `[QueryRouter] Follow-up rewrite (rules): "${normalizedQuestion}" → "${rewrittenQuery}"`,
      );
    }
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.SEMANTIC_RAG,
        userLanguage,
        confidence: 0.93,
        rewrittenQuery,
        followUp: true,
        needsRewrite: Boolean(rewrittenQuery),
        rewriteReason: rewrittenQuery ? "ELLIPSIS" : null,
        source: "rules_follow_up_acceptance",
      }),
    };
  }

  if (isCategoryNavigationRequest(normalizedQuestion)) {
    return {
      confident: true,
      result: buildRouteResult({
        route: ROUTES.HYBRID,
        subIntent: SUB_INTENTS.PAGE_LINKS,
        userLanguage,
        confidence: 0.96,
        source: "rules_category_navigation",
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

  // Multi-entity modes (compare / multi-ask / choose-from-list) — names may be empty.
  const multiFromRules = detectMultiEntityFromRules(normalizedQuestion);
  if (multiFromRules.multiEntityMode) {
    return {
      confident: false,
      result: buildRouteResult({
        route: ROUTES.SEMANTIC_RAG,
        userLanguage,
        confidence: 0.85,
        multiEntityMode: multiFromRules.multiEntityMode,
        rawEntities: multiFromRules.rawEntities,
        followUp: multiFromRules.multiEntityMode === "choose_from_list",
        source: "rules_multi_entity",
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
        rewrittenQuery:
          retrievalQuery !== normalizedQuestion ? retrievalQuery : null,
        followUp: true,
        needsRewrite: retrievalQuery !== normalizedQuestion,
        rewriteReason:
          retrievalQuery !== normalizedQuestion ? "CATALOG_EXPAND" : null,
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

    const userLanguage = normalizeLanguageCode(parsed.userLanguage) || "en";

    const rewrittenQuery =
      typeof parsed.rewrittenQuery === "string" && parsed.rewrittenQuery.trim()
        ? parsed.rewrittenQuery.trim()
        : null;

    const recall = parseRecallIntent(parsed.recall);

    const followUp = Boolean(parsed.followUp);
    const needsRewrite =
      Boolean(parsed.needsRewrite) || Boolean(rewrittenQuery);
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
    if (finalRoute === ROUTES.CONVERSATION_RECALL && !recall) {
      finalRoute = ROUTES.SEMANTIC_RAG;
    }
    if (confidence < 0.4 && finalRoute !== ROUTES.CONVERSATION_RECALL) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    } else if (
      confidence < 0.65 &&
      finalRoute !== ROUTES.LIVE_AGENT &&
      finalRoute !== ROUTES.CONVERSATION_RECALL
    ) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    } else if (finalRoute === ROUTES.HYBRID && !subIntent) {
      finalRoute = ROUTES.SEMANTIC_RAG;
    }

    // Preserve the semantic flags requested from the router. Identity is a
    // hard routing invariant, not merely a prompt suggestion.
    const isIdentityQuestion =
      Boolean(parsed.isIdentityQuestion) ||
      isCompanyIdentityQuestion(question);
    const isBusinessQuestion =
      Boolean(parsed.isBusinessQuestion) || isIdentityQuestion;
    const isTrulyOffTopic =
      !isIdentityQuestion && Boolean(parsed.isTrulyOffTopic);

    if (isIdentityQuestion && finalRoute !== ROUTES.CONVERSATION_RECALL) {
      finalRoute = ROUTES.SEMANTIC_RAG;
      subIntent = null;
    }

    if (finalRoute === ROUTES.CONVERSATION_RECALL) {
      return buildRouteResult({
        route: ROUTES.CONVERSATION_RECALL,
        userLanguage,
        confidence,
        recall,
        source: "llm_router",
      });
    }

    const lexicalTerms = Array.isArray(parsed.lexicalTerms)
      ? parsed.lexicalTerms
          .filter((t) => typeof t === "string" && t.trim())
          .map((t) => t.trim().toLowerCase())
          .slice(0, 8)
      : [];

    const multiEntityMode = normalizeMultiEntityMode(parsed.multiEntityMode);
    const rawEntities = Array.isArray(parsed.rawEntities)
      ? parsed.rawEntities
          .map((e) => String(e || "").trim())
          .filter((e) => e.length > 1)
          .slice(0, 5)
      : [];

    const ruleMulti = detectMultiEntityFromRules(question);
    const effectiveRawEntities =
      rawEntities.length >= 2 ? rawEntities : ruleMulti.rawEntities;
    const effectiveMultiEntityMode =
      multiEntityMode ||
      ruleMulti.multiEntityMode ||
      (effectiveRawEntities.length >= 2
        ? MULTI_ENTITY_MODES.MULTI_ASK
        : null);

    return buildRouteResult({
      route: finalRoute,
      subIntent,
      userLanguage,
      confidence,
      rewrittenQuery,
      lexicalTerms,
      constraints: parsed.constraints,
      multiEntityMode: effectiveMultiEntityMode,
      rawEntities: effectiveRawEntities,
      followUp,
      needsRewrite,
      rewriteReason,
      isIdentityQuestion,
      isBusinessQuestion,
      isTrulyOffTopic,
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
    recallInventory = null,
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

  // user intent prompt -->

  const systemPrompt = userIntentPrompt(websiteLanguage);

  const userContentParts = [`Website language: ${websiteLanguage}`];

  if (conversationStateSnippet) {
    userContentParts.push(`Conversation state:\n${conversationStateSnippet}`);
  } else {
    userContentParts.push("Conversation state: (none)");
  }

  if (chatHistorySnippet) {
    userContentParts.push(`Recent conversation:\n${chatHistorySnippet}`);
  }

  if (recallInventory) {
    userContentParts.push(
      `Chat inventory:\n- user_turns: ${Number(recallInventory.userTurnCount) || 0}\n- assistant_turns: ${Number(recallInventory.assistantTurnCount) || 0}`,
    );
  }

  console.log("chat history snippet :", chatHistorySnippet);

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
          `[QueryRouter] Error logging routing usage: ${logError.message}`,
        );
      }
    }

    const parsedRouting = parseRouterJson(content, question);
    console.log("parsed content data check : ", parsedRouting);

    return parsedRouting;
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
    recallInventory = null,
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

  console.log(
    "shouldDeferToLlmRouter:",
    shouldDeferToLlmRouter(question, ruleOutcome),
  );

  if (!shouldDeferToLlmRouter(question, ruleOutcome)) {
    return ruleOutcome.result;
  }

  const conversationStateSnippet = formatStateForRouter(conversationState);
  // Always include recent turns so soft offers / last assistant lines are visible
  // even when ragState already summarizes the topic.
  const chatHistorySnippet = formatRecentChatForRouter(chatMessages);

  console.log("conversation state for LLM routing:", conversationStateSnippet);
  console.log("chat history snippet for LLM routing:", chatHistorySnippet);

  console.log(
    `[QueryRouter] LLM routing (rules deferred: ${ruleOutcome.confident ? ruleOutcome.result?.source : "no_match"}) for: ${question.substring(0, 80)}`,
  );

  const llmResult = await llmRoute(question, {
    chatHistorySnippet,
    conversationStateSnippet,
    websiteLanguage,
    openaiClient,
    logOpenAIUsage,
    routerModel,
    recallInventory,
  });


  let result = applyFollowUpAcceptanceOverride(llmResult, question, {
    chatMessages,
    conversationState,
  });

  // Nano often labels incomplete accepts as ACK with no rewrite; force RAG + history rewrite.
  if (
    result.route === ROUTES.ACKNOWLEDGEMENT &&
    !isPureThanks(question) &&
    detectFollowUpAcceptance(question, chatMessages, conversationState)
  ) {
    result = applyFollowUpAcceptanceOverride(
      {
        ...result,
        route: ROUTES.SEMANTIC_RAG,
        source: result.source || "llm_router",
      },
      question,
      { chatMessages, conversationState },
    );
  }

  result = applyConversationRecallContract(
    result,
    question,
    chatMessages,
    recallInventory,
  );

  console.log("result check is applyConversationRecallContract",result);

  return result;
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
  isCategoryNavigationRequest,
  isSimpleGreeting,
  isPureGreeting,
  isLiveAgentRequest,
  formatRecentChatForRouter,
  detectSoftOffer,
  isShortAffirmative,
  detectFollowUpAcceptance,
  applyFollowUpAcceptanceOverride,
  rewriteFollowUpFromIntentContext,
  rewriteFromConversationState,
  applyConversationRecallContract,
};
