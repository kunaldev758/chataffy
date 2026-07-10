const axios = require("axios");
const { logOpenAIUsage } = require("./UsageTrackingService");

function getLlamaConfig() {
  const provider = String(
    process.env.LLAMA_PROVIDER || process.env.LLAMA_MICRO_PROVIDER || "ollama"
  ).toLowerCase();
  const timeoutMs =
    Number(process.env.LLAMA_TIMEOUT_MS || process.env.LLAMA_MICRO_TIMEOUT_MS) ||
    4000;

  if (provider === "groq") {
    return {
      provider: "groq",
      model:
        process.env.LLAMA_MODEL ||
        process.env.LLAMA_MICRO_MODEL ||
        "llama-3.1-8b-instant",
      apiKey: process.env.GROQ_API_KEY,
      timeoutMs,
    };
  }

  return {
    provider: "ollama",
    model:
      process.env.LLAMA_MODEL ||
      process.env.LLAMA_MICRO_MODEL ||
      "llama3.1:8b",
    baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    timeoutMs,
  };
}

function isLlamaFeatureEnabled(feature = "greeting") {
  if (String(process.env.LLAMA_ENABLED || "").toLowerCase() === "true") {
    return true;
  }

  const envKey =
    feature === "contact" ? "LLAMA_CONTACT_ENABLED" : "LLAMA_GREETING_ENABLED";
  const flag = String(process.env[envKey] || "").toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;

  const cfg = getLlamaConfig();
  if (cfg.provider === "groq") return Boolean(cfg.apiKey);
  return false;
}

function isLlamaConfigured(feature = "greeting") {
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
  // Ollama may return eval_count (output tokens) and prompt_eval_count (input tokens)
  const usage = res.data?.eval_count != null
    ? {
        prompt_tokens: res.data.prompt_eval_count || 0,
        completion_tokens: res.data.eval_count || 0,
        total_tokens: (res.data.prompt_eval_count || 0) + (res.data.eval_count || 0),
      }
    : null;
  return { text, usage };
}

async function callGroq({ model, prompt, apiKey, timeoutMs, system, maxTokens = 120 }) {
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
}) {
  if (!isLlamaFeatureEnabled(feature)) return null;

  const cfg = getLlamaConfig();
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

    if (result.usage && userId) {
      logOpenAIUsage({
        userId,
        agentId,
        model: cfg.model,
        type: "open-source",
        inputTokens: result.usage.prompt_tokens || 0,
        outputTokens: result.usage.completion_tokens || 0,
        cacheTokens: 0,
        totalTokens: result.usage.total_tokens || 0,
        inputCost: 0,
        outputCost: 0,
        cacheCost: 0,
        totalCost: 0,
      }).catch((err) =>
        console.warn(`[LlamaClient] Error logging usage: ${err.message}`)
      );
    }

    return result.text;
  } catch (error) {
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
