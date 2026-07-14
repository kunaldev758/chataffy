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
 * Resolve Llama/open-source config from DB (greeting → micro-classifier fallback),
 * with env used for OLLAMA_BASE_URL / GROQ_API_KEY so local vs production stay correct.
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


  console.log("feature in the get lamma config check : ",feature);

const primary =
  feature === "website"
    ? "website-classifier"
    : lightweightFeatures.has(feature)
      ? "micro-classifier"
      : "micro-classifier";


  console.log("primary check :",primary)

  const fallbacks =
    primary === "greeting"
      ? ["micro-classifier", "open-source"]
      : primary === "website-classifier"
        ? ["open-source"]
        : ["open-source"];

  const cfg = await getResolvedModelConfig(primary, fallbacks);


  console.log("cfg check : ",cfg)

  return {
    provider: cfg.provider === "groq" ? "groq" : "ollama",
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
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
    if (cfg.fromDb) return true;
    if (cfg.provider === "groq") return Boolean(cfg.apiKey);
    // ollama without DB: only if explicitly enabled via env above
    return false;
  } catch {
    return false;
  }
}

async function isLlamaConfigured(feature = "greeting") {
  return isLlamaFeatureEnabled(feature);
}

async function callOllama({ model, prompt, baseUrl, timeoutMs, system }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    url,
    {
      model,
      messages,
      stream: false,
      options: { temperature: 0.4 },
    },
    { timeout: timeoutMs }
  );

  const text = String(res.data?.message?.content || res.data?.response || "").trim();
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
  try {
    let result;
    if (cfg.provider === "groq") {
      if (!cfg.apiKey) return null;
      result = await callGroq({
        model: cfg.model,
        prompt,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
        system,
        maxTokens,
      });
    } else {
      result = await callOllama({
        model: cfg.model,
        prompt,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        system,
      });
    }


    console.log("result check : ",result);

    console.log(`[LlamaClient] ${cfg.provider}`,{
      model: cfg.model,
      prompt,
      system,
      text: result.text,
      usage: result.usage,

    })

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

    console.log("result check : ",error);
    console.warn(`[LlamaClient] ${cfg.provider} call failed:`, error.message);
    return null;
  }
}

module.exports = {
  completeLlama,
  isLlamaConfigured,
  isLlamaFeatureEnabled,
  getLlamaConfig,
};
