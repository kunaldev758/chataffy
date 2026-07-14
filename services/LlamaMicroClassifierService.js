const axios = require("axios");
const { normalizeLanguageCode } = require("../utils/websiteLanguage");
const {
  logOpenAIUsage,
  computeTokenCosts,
} = require("./UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");

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
  const usage =
    res.data?.eval_count != null
      ? {
          prompt_tokens: res.data.prompt_eval_count || 0,
          completion_tokens: res.data.eval_count || 0,
          total_tokens:
            (res.data.prompt_eval_count || 0) + (res.data.eval_count || 0),
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
 * Optional micro-classifier using an open-weight Llama model via Ollama or Groq.
 * Config resolved from AiModel category `micro-classifier` (env fallback).
 * OLLAMA_BASE_URL / GROQ_API_KEY from env win for local vs production.
 */
async function classifyShortText({
  message,
  websiteLanguage,
  visitorLocale,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const explicitEnabled = String(process.env.LLAMA_MICRO_ENABLED || "").toLowerCase();
  let cfg;
  try {
    cfg = await getResolvedModelConfig("micro-classifier", ["open-source"]);
  } catch {
    return null;
  }

  // Explicit false disables; otherwise allow when DB has an active model or env says true
  if (explicitEnabled === "false") return null;
  if (explicitEnabled !== "true" && !cfg.fromDb) return null;

  const provider = cfg.provider === "groq" ? "groq" : "ollama";
  const timeoutMs = cfg.timeoutMs || 2000;
  const prompt = buildClassifierPrompt({
    message,
    websiteLanguage,
    visitorLocale,
  });

  let raw = "";
  let callUsage = null;
  const callModel = cfg.model;
  try {
    if (provider === "groq") {
      if (!cfg.apiKey) return null;
      const result = await callGroq({
        model: callModel,
        prompt,
        apiKey: cfg.apiKey,
        timeoutMs,
      });
      raw = result.text;
      callUsage = result.usage;
    } else {
      const result = await callOllama({
        model: callModel,
        prompt,
        baseUrl: cfg.baseUrl,
        timeoutMs,
      });
      raw = result.text;
      callUsage = result.usage;
    }
  } catch {
    return null;
  }

  if (callUsage && userId) {
    const costs = computeTokenCosts({
      inputTokens: callUsage.prompt_tokens || 0,
      outputTokens: callUsage.completion_tokens || 0,
      cacheTokens: 0,
      inputCostPerMillion: cfg.inputCost,
      outputCostPerMillion: cfg.outputCost,
      cacheCostPerMillion: cfg.cacheCost,
    });
    logOpenAIUsage({
      userId,
      agentId,
      conversationId,
      model: callModel,
      type: usageTypeForCategory("micro-classifier"),
      inputTokens: callUsage.prompt_tokens || 0,
      outputTokens: callUsage.completion_tokens || 0,
      cacheTokens: 0,
      totalTokens: callUsage.total_tokens || 0,
      ...costs,
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
