const axios = require("axios");
const {
  logOpenAIUsage,
  computeTokenCosts,
} = require("./UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");

/**
 * Resolve Llama/open-source config from DB (greeting → micro-classifier fallback).
 * GROQ_API_KEY from env wins so local vs production stay correct.
 */
async function getLlamaConfig(feature = "greeting") {
  // Lightweight reply features share greeting / micro-classifier model config.
  const lightweightFeatures = new Set([
    "greeting",
    "contact",
    "accidental",
    "live_agent",
    "off_topic",
  ]);

  const primary =
    feature === "website"
      ? "website-classifier"
      : lightweightFeatures.has(feature)
        ? "micro-classifier"
        : "micro-classifier";

  const fallbacks =
    primary === "greeting"
      ? ["micro-classifier", "open-source"]
      : primary === "website-classifier"
        ? ["open-source"]
        : ["open-source"];

  const cfg = await getResolvedModelConfig(primary, fallbacks);

  return {
    provider: cfg.provider === "groq" ? "groq" : null,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    inputCost: cfg.inputCost,
    outputCost: cfg.outputCost,
    cacheCost: cfg.cacheCost,
    fromDb: cfg.fromDb,
    category: cfg.category,
  };
}

function isLlamaEnvEnabled(feature = "greeting") {
  if (String(process.env.LLAMA_ENABLED || "").toLowerCase() === "true") {
    return true;
  }
  if (String(process.env.LLAMA_MICRO_ENABLED || "").toLowerCase() === "true") {
    return true;
  }

  const featureEnvMap = {
    contact: "LLAMA_CONTACT_ENABLED",
    greeting: "LLAMA_GREETING_ENABLED",
    accidental: "LLAMA_GREETING_ENABLED",
    live_agent: "LLAMA_GREETING_ENABLED",
    off_topic: "LLAMA_GREETING_ENABLED",
  };
  const envKey = featureEnvMap[feature] || "LLAMA_GREETING_ENABLED";
  const flag = String(process.env[envKey] || "").toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return null; // undecided — check DB
}

function estimateUsageFromText({ system, prompt, text }) {
  const inputChars =
    String(system || "").length + String(prompt || "").length;
  const outputChars = String(text || "").length;
  const prompt_tokens = Math.max(1, Math.ceil(inputChars / 4));
  const completion_tokens = Math.max(1, Math.ceil(outputChars / 4));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

function logLlamaUsage({
  cfg,
  usage,
  userId,
  agentId,
  conversationId,
}) {
  if (!userId || !usage) return;

  const costs = computeTokenCosts({
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    cacheTokens: 0,
    inputCostPerMillion: cfg.inputCost,
    outputCostPerMillion: cfg.outputCost,
    cacheCostPerMillion: cfg.cacheCost,
  });

  logOpenAIUsage({
    userId,
    agentId,
    conversationId,
    model: cfg.model,
    type: usageTypeForCategory(cfg.category || "open-source"),
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    cacheTokens: 0,
    totalTokens: usage.total_tokens || 0,
    ...costs,
  }).catch((err) =>
    console.warn(`[LlamaClient] Error logging usage: ${err.message}`)
  );
}

async function isLlamaFeatureEnabled(feature = "greeting") {
  const envFlag = isLlamaEnvEnabled(feature);
  if (envFlag === false) return false;
  if (envFlag === true) return true;

  try {
    const cfg = await getLlamaConfig(feature);
    if (cfg.fromDb && cfg.provider === "groq") return true;
    if (cfg.provider === "groq") return Boolean(cfg.apiKey);
    return false;
  } catch {
    return false;
  }
}

async function isLlamaConfigured(feature = "greeting") {
  return isLlamaFeatureEnabled(feature);
}

async function callGroq({
  model,
  prompt,
  apiKey,
  timeoutMs,
  system,
  maxTokens = 120,
}) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    url,
    {
      model,
      temperature: 0.4,
      max_tokens: maxTokens,
      messages,
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

async function completeLlama({
  system,
  prompt,
  feature = "greeting",
  maxTokens = 120,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  if (!(await isLlamaFeatureEnabled(feature))) return null;

  const cfg = await getLlamaConfig(feature);
  if (cfg.provider !== "groq" || !cfg.apiKey) return null;

  try {
    const result = await callGroq({
      model: cfg.model,
      prompt,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      system,
      maxTokens,
    });

    if (result.text && userId) {
      const usage =
        result.usage ||
        estimateUsageFromText({ system, prompt, text: result.text });
      logLlamaUsage({
        cfg,
        usage,
        userId,
        agentId,
        conversationId,
      });
    }

    return result.text;
  } catch (error) {
    console.warn(`[LlamaClient] groq call failed:`, error.message);
    return null;
  }
}

module.exports = {
  completeLlama,
  isLlamaConfigured,
  isLlamaFeatureEnabled,
  getLlamaConfig,
};
