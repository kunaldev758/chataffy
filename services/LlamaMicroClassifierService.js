const axios = require("axios");
const { normalizeLanguageCode } = require("../utils/websiteLanguage");
const { logOpenAIUsage } = require("./UsageTrackingService");

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeLang(raw) {
  const code = normalizeLanguageCode(raw);
  return code || null;
}

function buildClassifierPrompt({ message, websiteLanguage, visitorLocale }) {
  const wl = normalizeLang(websiteLanguage) || "en";
  const vl = normalizeLang(visitorLocale);

  return [
    "You are a fast text classifier for a customer-support chat widget.",
    "You MUST respond with JSON only (no markdown, no extra text).",
    "",
    "Classify the visitor message into:",
    '- isGreeting: true when it is ONLY a greeting / hello with no real question.',
    "- isGibberish: true when it is random typing, keyboard mash, or test input.",
    "",
    "Also output userLanguage as ISO 639-1 (en, es, ru, ja, etc.).",
    "",
    "Rules:",
    "- If message contains a real question or request, isGreeting must be false.",
    "- Prefer using visitorLocale when the text is too short/ambiguous (e.g. 'hii').",
    `- websiteLanguage hint: ${wl}`,
    `- visitorLocale hint: ${vl || "unknown"}`,
    "",
    "Return JSON shape:",
    '{ "isGreeting": false, "isGibberish": false, "userLanguage": "en", "confidence": 0.8 }',
    "",
    `Visitor message: ${JSON.stringify(String(message || ""))}`,
  ].join("\n");
}

async function callOllama({ model, prompt, baseUrl, timeoutMs }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/generate`;
  const res = await axios.post(
    url,
    {
      model,
      prompt,
      stream: false,
      options: { temperature: 0 },
    },
    { timeout: timeoutMs }
  );
  const text = String(res.data?.response || "").trim();
  const usage = res.data?.eval_count != null
    ? {
        prompt_tokens: res.data.prompt_eval_count || 0,
        completion_tokens: res.data.eval_count || 0,
        total_tokens: (res.data.prompt_eval_count || 0) + (res.data.eval_count || 0),
      }
    : null;
  return { text, usage };
}

async function callGroq({ model, prompt, apiKey, timeoutMs }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const res = await axios.post(
    url,
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: prompt },
      ],
    },
    {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );
  const text = String(res.data?.choices?.[0]?.message?.content || "").trim();
  const usage = res.data?.usage || null;
  return { text, usage };
}

/**
 * Optional micro-classifier using an open-weight Llama model via:
 * - Ollama (local) or
 * - Groq (hosted, often free tier)
 *
 * Controlled by env vars:
 * - LLAMA_MICRO_ENABLED=true|false (default false)
 * - LLAMA_MICRO_PROVIDER=ollama|groq (default ollama)
 * - LLAMA_MICRO_MODEL (default llama3.1:8b for ollama, llama-3.1-8b-instant for groq)
 * - OLLAMA_BASE_URL (default http://127.0.0.1:11434)
 * - GROQ_API_KEY (required for groq)
 * - LLAMA_MICRO_TIMEOUT_MS (default 2000)
 */
async function classifyShortText({
  message,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
}) {
  const enabled = String(process.env.LLAMA_MICRO_ENABLED || "false") === "true";
  if (!enabled) return null;

  const provider = String(process.env.LLAMA_MICRO_PROVIDER || "ollama").toLowerCase();
  const timeoutMs = Number(process.env.LLAMA_MICRO_TIMEOUT_MS) || 2000;

  const prompt = buildClassifierPrompt({
    message,
    websiteLanguage,
    visitorLocale,
  });

  let raw = "";
  let callUsage = null;
  let callModel = null;
  try {
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return null;
      callModel = process.env.LLAMA_MICRO_MODEL || "llama-3.1-8b-instant";
      const result = await callGroq({ model: callModel, prompt, apiKey, timeoutMs });
      raw = result.text;
      callUsage = result.usage;
    } else {
      callModel = process.env.LLAMA_MICRO_MODEL || "llama3.1:8b";
      const baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
      const result = await callOllama({ model: callModel, prompt, baseUrl, timeoutMs });
      raw = result.text;
      callUsage = result.usage;
    }
  } catch {
    return null;
  }

  if (callUsage && userId) {
    logOpenAIUsage({
      userId,
      agentId,
      model: callModel,
      type: "open-source",
      inputTokens: callUsage.prompt_tokens || 0,
      outputTokens: callUsage.completion_tokens || 0,
      cacheTokens: 0,
      totalTokens: callUsage.total_tokens || 0,
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      totalCost: 0,
    }).catch((err) =>
      console.warn(`[LlamaMicroClassifier] Error logging usage: ${err.message}`)
    );
  }

  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.6;

  return {
    isGreeting: Boolean(parsed.isGreeting),
    isGibberish: Boolean(parsed.isGibberish),
    userLanguage: normalizeLang(parsed.userLanguage) || null,
    confidence,
    raw,
    provider,
  };
}

module.exports = {
  classifyShortText,
};

