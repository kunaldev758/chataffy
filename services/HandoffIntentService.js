require("dotenv").config();
const { OpenAI } = require("openai");
const { logOpenAIUsage } = require("./UsageTrackingService");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const INTENT_MODEL =
  process.env.OPENAI_INTENT_MODEL || "gpt-4.1-mini";
const USE_LLM = process.env.HANDOFF_INTENT_USE_LLM !== "false";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const CONFIRM_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|please|connect me|do it|go ahead|absolutely|correct|right)(\s+please)?$/i;

const HANDOFF_OFFER_RE =
  /connect you (with|to) (a |an )?(live )?(agent|human|person|representative|support)|would you like (me to )?(speak|talk|connect)|shall i connect|want me to connect|transfer you to/i;

const HANDOFF_RE =
  /\b(speak|talk|chat|connect|transfer|escalat(e|ion)|reach|get)\b.{0,40}\b(agent|human|person|representative|rep|support team|team member|someone real|live person|real person|customer service|live agent|human agent)\b/i;

const EXPLICIT_PHRASES = [
  "customer service",
  "customer support",
  "live chat",
  "live support",
  "live agent",
  "human agent",
  "real person",
  "not a bot",
  "stop bot",
  "speak to someone",
  "talk to someone",
  "connect to someone",
  "speak with someone",
  "talk with someone",
  "need a human",
  "need an agent",
  "want a human",
  "want an agent",
  "human please",
  "agent please",
  "i want to speak",
  "i want to talk",
  "can i speak",
  "can i talk",
  "need to speak",
  "need to talk",
];

const FALSE_POSITIVE_RE = [
  /\bshipping agent\b/i,
  /\btravel agent\b/i,
  /\binsurance agent\b/i,
  /\breal estate agent\b/i,
  /\bsales agent\b/i,
];

const CLARIFIER_MESSAGE =
  "Would you like me to connect you with a live agent? Just say yes and I'll try to reach someone for you.";

const LIVE_CHAT_UNAVAILABLE_MESSAGE =
  "Live chat isn't available right now. I'm here to help — what can I assist you with?";

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[^;]+;/g, " ");
}

function normalize(text) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastAiMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.sender_type === "ai") return stripHtml(m.message);
  }
  return null;
}

function isHandoffOffer(text) {
  return HANDOFF_OFFER_RE.test(stripHtml(text));
}

/**
 * Fast rule-based handoff detection. No API calls.
 * @returns {{ decision: 'handoff'|'not_handoff'|'clarify'|'uncertain', confidence: number, reason?: string }}
 */
function detectWithRules(message, recentMessages = []) {
  const raw = stripHtml(message);
  const normalized = normalize(message);
  if (!normalized) {
    return { decision: "uncertain", confidence: 0 };
  }

  if (FALSE_POSITIVE_RE.some((re) => re.test(raw))) {
    return { decision: "not_handoff", confidence: 0.9, reason: "false_positive" };
  }

  const lastAi = getLastAiMessage(recentMessages);
  if (lastAi && isHandoffOffer(lastAi) && CONFIRM_RE.test(normalized)) {
    return {
      decision: "handoff",
      confidence: 0.95,
      reason: "confirm_after_offer",
    };
  }

  if (EXPLICIT_PHRASES.some((p) => normalized.includes(p))) {
    return { decision: "handoff", confidence: 0.92, reason: "explicit_phrase" };
  }

  if (HANDOFF_RE.test(normalized)) {
    return { decision: "handoff", confidence: 0.9, reason: "pattern" };
  }

  if (
    /\b(bot|useless|not helping|frustrated|annoyed)\b/.test(normalized) &&
    /\b(human|person|agent|someone|real)\b/.test(normalized)
  ) {
    return { decision: "handoff", confidence: 0.88, reason: "frustration" };
  }

  if (/^(help|support)$/.test(normalized)) {
    return { decision: "clarify", confidence: 0.5, reason: "vague" };
  }

  if (
    /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you)$/.test(
      normalized,
    )
  ) {
    return { decision: "not_handoff", confidence: 0.85, reason: "greeting" };
  }

  return { decision: "uncertain", confidence: 0 };
}

function formatRecentForLlm(messages, limit = 4) {
  return messages
    .slice(-limit)
    .map((m) => {
      const role =
        m.sender_type === "visitor" || m.sender_type === "user"
          ? "visitor"
          : m.sender_type === "ai"
            ? "ai"
            : "other";
      return `${role}: ${stripHtml(m.message).slice(0, 200)}`;
    })
    .join("\n");
}

async function classifyWithLlm(message, recentMessages, userId, agentId) {
  if (!openai) return null;

  const history = formatRecentForLlm(recentMessages);
  const systemPrompt = `You classify visitor chat messages for a support widget.
Return JSON only: {"intent":"handoff_to_human"|"confirm_handoff"|"decline_handoff"|"faq"|"greeting"|"other","confidence":0.0-1.0}
Rules:
- handoff_to_human: visitor clearly wants a real person, live agent, or human support
- confirm_handoff: visitor accepts a prior offer to connect to a human (e.g. "yes", "please do")
- decline_handoff: visitor wants to stay with AI
- faq/greeting/other: no handoff request
Be conservative: only handoff_to_human or confirm_handoff when clearly requested.`;

  const userPrompt = `Recent messages:\n${history || "(none)"}\n\nCurrent visitor message: ${stripHtml(message).slice(0, 500)}`;

  try {
    const response = await openai.chat.completions.create({
      model: INTENT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 80,
    });

    const usage = response.usage;
    if (usage && userId) {
      logOpenAIUsage({
        userId,
        agentId,
        tokens: usage.total_tokens,
        requests: 1,
        model: INTENT_MODEL,
      });
    }

    const parsed = JSON.parse(
      response.choices[0]?.message?.content?.trim() || "{}",
    );
    const intent = parsed.intent || "other";
    const confidence = Number(parsed.confidence) || 0;

    if (
      (intent === "handoff_to_human" || intent === "confirm_handoff") &&
      confidence >= 0.75
    ) {
      return {
        decision: "handoff",
        confidence,
        reason: `llm:${intent}`,
      };
    }
    if (intent === "decline_handoff" || confidence >= 0.8) {
      return { decision: "not_handoff", confidence, reason: `llm:${intent}` };
    }
    return { decision: "uncertain", confidence, reason: `llm:${intent}` };
  } catch (error) {
    console.error("[HandoffIntentService] LLM classify error:", error.message);
    return null;
  }
}

function rulesToResult(rules) {
  if (rules.decision === "handoff") {
    return {
      isHandoff: true,
      confidence: rules.confidence,
      source: "rules",
      reason: rules.reason,
    };
  }
  if (rules.decision === "not_handoff") {
    return {
      isHandoff: false,
      confidence: rules.confidence,
      source: "rules",
      reason: rules.reason,
    };
  }
  if (rules.decision === "clarify") {
    return {
      isHandoff: false,
      needsClarification: true,
      confidence: rules.confidence,
      source: "rules",
      reason: rules.reason,
      clarifierMessage: CLARIFIER_MESSAGE,
    };
  }
  return null;
}

/**
 * Full intent detection: rules first, LLM only when uncertain.
 */
async function detectHandoffIntent(
  message,
  recentMessages = [],
  options = {},
) {
  const { userId, agentId, skipLlm = false } = options;

  const rules = detectWithRules(message, recentMessages);
  const fromRules = rulesToResult(rules);
  if (fromRules) return fromRules;

  if (skipLlm || !USE_LLM) {
    return { isHandoff: false, confidence: 0, source: "rules" };
  }

  const llmRules = await classifyWithLlm(
    message,
    recentMessages,
    userId,
    agentId,
  );
  if (!llmRules) {
    return { isHandoff: false, confidence: 0, source: "rules" };
  }

  const fromLlm = rulesToResult(llmRules);
  if (fromLlm) {
    fromLlm.source = "llm";
    return fromLlm;
  }

  return { isHandoff: false, confidence: llmRules.confidence, source: "llm" };
}

/** Sync check for backward-compatible keyword-style usage. */
function isHandoffRequest(message, recentMessages = []) {
  const rules = detectWithRules(message, recentMessages);
  return rules.decision === "handoff";
}

module.exports = {
  detectHandoffIntent,
  detectWithRules,
  isHandoffRequest,
  CLARIFIER_MESSAGE,
  LIVE_CHAT_UNAVAILABLE_MESSAGE,
};


