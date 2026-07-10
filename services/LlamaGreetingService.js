const { completeLlama } = require("./LlamaClient");
const { buildGreetingResponse } = require("./LightweightResponseService");

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
 */
async function generateGreeting({
  companyName,
  userMessage,
  userLanguage,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
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

  const raw = await completeLlama({ system, prompt, userId, agentId });
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

module.exports = {
  generateGreeting,
};
