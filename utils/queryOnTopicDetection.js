/**
 * Detect business-support questions that should never be treated as off-topic
 * based only on low embedding similarity scores.
 *
 * Regex patterns run first (fast path for English). When regex does not match,
 * LLM router intent flags are used as a multilingual fallback.
 */

const ON_TOPIC_PATTERNS = [
  /\b(?:tell\s+me|explain|describe)\s+(?:about\s+)?(?:your|our|the)\s+(?:services?|products?|company|business|offerings?|platform|app|tool|solution|features?|pricing|plans?)\b/i,
  /\b(?:what|which)\s+(?:are|is)\s+(?:your|our)\s+(?:services?|products?|features?|plans?|pricing|prices?|offerings?)\b/i,
  /\b(?:describe|introduce)\s+(?:yourself|your\s+company|the\s+company|you)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bwhat\s+do\s+you\s+do\b/i,
  /\bwhat\s+(?:is|does)\s+\w+\s+do\b/i,
  /\b(?:about\s+you|about\s+your\s+company|about\s+the\s+company)\b/i,
  /\b(?:your|our)\s+(?:services?|products?|pricing|prices?|features?|benefits?|plans?|policies?)\b/i,
  /\b(?:how\s+(?:much|do\s+i|can\s+i|does)|pricing|refund|return|shipping|warranty|support|billing|cancel)\b/i,
  /\b(?:contact|phone|email|address|hours|office)\b/i,
  /\bhow\s+(?:does|do)\s+(?:it|this|your|the)\s+(?:work|help)\b/i,
  /\b(?:give|show)\s+me\b[\s\S]{0,40}\b(?:lash|lashes|products?|items?)\b/i,
  /\b\d{1,2}(?:-\d{1,2})?mm\b[\s\S]{0,30}\b(?:lash|lashes|products?)\b/i,
  /\b(?:give|show)\s+me\b[\s\S]{0,40}\b(?:social|social\s*media)\b/i,
  /\b(?:social\s*media|social)\b[\s\S]{0,30}\b(?:links?|urls?|profiles?)\b/i,
  /\b(?:facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest)\b/i,
];

const IDENTITY_PATTERNS = [
  /\b(?:describe|introduce)\s+(?:yourself|your\s+company|the\s+company|you)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\babout\s+you\b/i,
  /\bwhat\s+do\s+you\s+do\b/i,
];

/** General knowledge / unrelated topics — safe to redirect with a template. */
const TRULY_OFF_TOPIC_PATTERNS = [
  /\b(?:weather|forecast|temperature)\b/i,
  /\b(?:tell\s+me\s+a\s+joke|make\s+me\s+laugh)\b/i,
  /\b(?:who\s+won|football|soccer|cricket|nba|nfl)\b/i,
  /\b(?:recipe|cook|bake)\s+/i,
  /\b(?:stock\s+price|bitcoin|crypto)\b/i,
  /\b(?:president|prime\s+minister)\s+of\b/i,
];

function isClearlyOnTopicByRegex(question, companyName = "") {
  const q = String(question || "").trim();
  if (!q) return false;
  return (
    ON_TOPIC_PATTERNS.some((re) => re.test(q)) ||
    isCompanyIdentityByRegex(q, companyName)
  );
}

function isCompanyIdentityByRegex(question, companyName = "") {
  const q = String(question || "").trim();
  if (!q) return false;
  if (IDENTITY_PATTERNS.some((re) => re.test(q))) return true;
  const company = String(companyName || "").trim();
  if (company.length >= 3) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const companyRe = new RegExp(`\\bwhat\\s+is\\s+${escaped}\\b`, "i");
    if (companyRe.test(q)) return true;
  }
  return false;
}

function isTrulyOffTopicByRegex(question, companyName = "") {
  const q = String(question || "").trim();
  if (!q) return false;
  if (isClearlyOnTopicByRegex(q, companyName)) return false;
  return TRULY_OFF_TOPIC_PATTERNS.some((re) => re.test(q));
}

/**
 * Resolve query intent: regex first, then LLM router flags as multilingual fallback.
 * @param {object} routing - routeQuery result (may include isIdentityQuestion, isBusinessQuestion, isTrulyOffTopic)
 */
function resolveQueryIntent(question, companyName = "", routing = {}) {
  const q = String(question || "").trim();

  if (isClearlyOnTopicByRegex(q, companyName)) {
    return {
      clearlyOnTopic: true,
      isIdentity: isCompanyIdentityByRegex(q, companyName),
      isTrulyOffTopic: false,
      source: "regex",
    };
  }

  if (isTrulyOffTopicByRegex(q, companyName)) {
    return {
      clearlyOnTopic: false,
      isIdentity: false,
      isTrulyOffTopic: true,
      source: "regex",
    };
  }

  const llmOnTopic =
    routing.isBusinessQuestion === true ||
    routing.isIdentityQuestion === true;
  const llmOffTopic = routing.isTrulyOffTopic === true;

  return {
    clearlyOnTopic: llmOnTopic,
    isIdentity: routing.isIdentityQuestion === true,
    isTrulyOffTopic: llmOffTopic && !llmOnTopic,
    source: routing.intentClassified ? "llm_intent" : "none",
  };
}

function isClearlyOnTopicCompanyQuestion(question, companyName = "", routing = {}) {
  return resolveQueryIntent(question, companyName, routing).clearlyOnTopic;
}

function isCompanyIdentityQuestion(question, companyName = "", routing = {}) {
  const intent = resolveQueryIntent(question, companyName, routing);
  return intent.isIdentity;
}

function isTrulyOffTopicQuestion(question, companyName = "", routing = {}) {
  return resolveQueryIntent(question, companyName, routing).isTrulyOffTopic;
}

function needsLazyIntentClassification(intent, routing = {}) {
  return (
    intent.source !== "regex" &&
    !routing.intentClassified &&
    !intent.clearlyOnTopic &&
    !intent.isTrulyOffTopic
  );
}

module.exports = {
  resolveQueryIntent,
  isClearlyOnTopicCompanyQuestion,
  isCompanyIdentityQuestion,
  isTrulyOffTopicQuestion,
  needsLazyIntentClassification,
  isClearlyOnTopicByRegex,
  isCompanyIdentityByRegex,
  isTrulyOffTopicByRegex,
};
