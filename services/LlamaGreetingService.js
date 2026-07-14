const { completeLlama } = require("./LlamaClient");
const {
  buildGreetingResponse,
  buildAccidentalResponse,
  buildLiveAgentResponse,
  buildOffTopicResponse,
} = require("./LightweightResponseService");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapAsHtml(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (/<\s*p[\s>]/i.test(trimmed)) return trimmed;
  return `<p>${trimmed}</p>`;
}

/**
 * Generate a short multilingual greeting using an open-weight Llama model.
 * Falls back to deterministic templates when Llama is disabled or fails.
 * Logs open-source usage via completeLlama when userId is provided.
 */
async function generateGreeting({
  companyName,
  userMessage,
  userLanguage,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const lang = userLanguage || "en";

  const system = [
    "You are a friendly customer-support chatbot.",
    "Write ONE short greeting reply (1-2 sentences max).",
    `Reply in language code: ${lang}.`,
    "Be warm and natural. Ask how you can help.",
    "Output HTML only: a single <p> tag. No markdown.",
  ].join(" ");

  const prompt = [
    `Company name: ${safeCompany}`,
    `Visitor message: ${JSON.stringify(String(userMessage || ""))}`,
    `Write the greeting in ${lang}.`,
  ].join("\n");

  const raw = await completeLlama({
    system,
    prompt,
    feature: "greeting",
    userId,
    agentId,
    conversationId,
  });
  const answer = wrapAsHtml(raw);

  if (answer) {
    return {
      answer,
      language: lang,
      source: "llama_greeting",
    };
  }

  const fallback = buildGreetingResponse({
    companyName,
    userMessage,
    routingUserLanguage: lang,
    visitorLocale,
    websiteLanguage,
  });

  return {
    answer: fallback.answer,
    language: fallback.language,
    source: "template_greeting_fallback",
  };
}

/**
 * Accidental / gibberish reply via Llama, with template fallback + usage logging.
 */
async function generateAccidentalReply({
  companyName,
  userMessage,
  userLanguage,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const lang = userLanguage || "en";

  const system = [
    "You are a friendly customer-support chatbot.",
    "The visitor sent accidental or gibberish input.",
    "Write ONE short polite reply asking them to rephrase.",
    `Reply in language code: ${lang}.`,
    "Output HTML only: a single <p> tag. No markdown.",
  ].join(" ");

  const prompt = [
    `Company name: ${safeCompany}`,
    `Visitor message: ${JSON.stringify(String(userMessage || ""))}`,
    `Write the reply in ${lang}.`,
  ].join("\n");

  const raw = await completeLlama({
    system,
    prompt,
    feature: "accidental",
    maxTokens: 80,
    userId,
    agentId,
    conversationId,
  });
  const answer = wrapAsHtml(raw);

  if (answer) {
    return {
      answer,
      language: lang,
      source: "llama_accidental",
    };
  }

  const fallback = buildAccidentalResponse({
    companyName,
    userMessage,
    routingUserLanguage: lang,
    visitorLocale,
    websiteLanguage,
  });

  return {
    answer: fallback.answer,
    language: fallback.language,
    source: fallback.source || "template_accidental_fallback",
  };
}

/**
 * Live-agent handoff reply via Llama, with template fallback + usage logging.
 */
async function generateLiveAgentReply({
  companyName,
  userMessage,
  userLanguage,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const lang = userLanguage || "en";

  const system = [
    "You are a friendly customer-support chatbot.",
    "The visitor asked to speak with a human agent.",
    "Write ONE short reply confirming you will connect them to a team member.",
    `Reply in language code: ${lang}.`,
    "Output HTML only: a single <p> tag. No markdown.",
  ].join(" ");

  const prompt = [
    `Company name: ${safeCompany}`,
    `Visitor message: ${JSON.stringify(String(userMessage || ""))}`,
    `Write the reply in ${lang}.`,
  ].join("\n");

  const raw = await completeLlama({
    system,
    prompt,
    feature: "live_agent",
    maxTokens: 80,
    userId,
    agentId,
    conversationId,
  });
  const answer = wrapAsHtml(raw);

  if (answer) {
    return {
      answer,
      language: lang,
      source: "llama_live_agent",
    };
  }

  const fallback = buildLiveAgentResponse({
    companyName,
    userMessage,
    routingUserLanguage: lang,
    visitorLocale,
    websiteLanguage,
  });

  return {
    answer: fallback.answer,
    language: fallback.language,
    source: fallback.source || "template_live_agent_fallback",
  };
}

/**
 * Off-topic / irrelevant reply via Llama, with template fallback + usage logging.
 */
async function generateOffTopicReply({
  companyName,
  userMessage,
  userLanguage,
  websiteLanguage,
  visitorLocale,
  isIrrelevant = false,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const lang = userLanguage || "en";

  const system = [
    "You are a friendly customer-support chatbot.",
    isIrrelevant
      ? "The visitor asked something unrelated to the company."
      : "The visitor asked something that may be off-topic for the company.",
    "Write ONE short polite redirect offering help with the company instead.",
    `Reply in language code: ${lang}.`,
    "Output HTML only: a single <p> tag. No markdown.",
  ].join(" ");

  const prompt = [
    `Company name: ${safeCompany}`,
    `Visitor message: ${JSON.stringify(String(userMessage || ""))}`,
    `Write the reply in ${lang}.`,
  ].join("\n");

  const raw = await completeLlama({
    system,
    prompt,
    feature: "off_topic",
    maxTokens: 100,
    userId,
    agentId,
    conversationId,
  });
  const answer = wrapAsHtml(raw);

  if (answer) {
    return {
      answer,
      language: lang,
      source: isIrrelevant ? "llama_irrelevant" : "llama_off_topic",
    };
  }

  const fallback = buildOffTopicResponse({
    companyName,
    userMessage,
    routingUserLanguage: lang,
    visitorLocale,
    websiteLanguage,
    isIrrelevant,
  });

  return {
    answer: fallback.answer,
    language: fallback.language,
    source: fallback.source || "template_off_topic_fallback",
  };
}

module.exports = {
  generateGreeting,
  generateAccidentalReply,
  generateLiveAgentReply,
  generateOffTopicReply,
};
