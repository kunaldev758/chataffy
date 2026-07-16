const {
  logOpenAIUsage,
  computeTokenCosts,
} = require("./UsageTrackingService");
const {
  getResolvedModelConfig,
  usageTypeForCategory,
} = require("./aiModelService");
const {
  providerChatComplete,
  isSupportedChatProvider,
} = require("./providerChatComplete");

/**
 * Resolve config from DB (micro-classifier / website-classifier / open-source).
 * Supports openai and groq; API keys from env win for local vs production.
 */
async function getLlamaConfig(feature = "greeting") {
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
  const provider = isSupportedChatProvider(cfg.provider) ? cfg.provider : null;

  return {
    provider,
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
    if (!cfg.provider) return false;
    if (cfg.fromDb) return Boolean(cfg.apiKey);
    return Boolean(cfg.apiKey);
  } catch {
    return false;
  }
}

async function isLlamaConfigured(feature = "greeting") {
  return isLlamaFeatureEnabled(feature);
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
  if (!cfg.provider || !cfg.apiKey) return null;

  try {
    const result = await providerChatComplete({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      system,
      maxTokens,
      temperature: 0.4,
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
    console.warn(
      `[LlamaClient] ${cfg.provider} call failed:`,
      error.message,
    );
    return null;
  }
}

module.exports = {
  completeLlama,
  isLlamaConfigured,
  isLlamaFeatureEnabled,
  getLlamaConfig,
};
