const axios = require("axios");

/**
 * OpenAI-compatible chat completion for openai or groq.
 * @returns {Promise<{ text: string, usage: object|null }>}
 */
async function providerChatComplete({
  provider,
  model,
  apiKey,
  timeoutMs = 30000,
  system,
  prompt,
  temperature = 0,
  maxTokens,
}) {
  const normalized = String(provider || "").toLowerCase();
  if (normalized !== "openai" && normalized !== "groq") {
    throw new Error(`Unsupported chat provider: ${provider}`);
  }
  if (!apiKey) {
    throw new Error(`Missing API key for provider: ${normalized}`);
  }

  const url =
    normalized === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    temperature,
    messages,
  };
  if (maxTokens != null) body.max_tokens = maxTokens;

  const res = await axios.post(url, body, {
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const text = String(res.data?.choices?.[0]?.message?.content || "").trim();
  const usage = res.data?.usage || null;
  return { text, usage };
}

function isSupportedChatProvider(provider) {
  const normalized = String(provider || "").toLowerCase();
  return normalized === "openai" || normalized === "groq";
}

module.exports = {
  providerChatComplete,
  isSupportedChatProvider,
};
