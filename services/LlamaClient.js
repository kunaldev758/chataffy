const axios = require("axios");

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

function isLlamaConfigured() {
  if (String(process.env.LLAMA_GREETING_ENABLED || "").toLowerCase() === "false") {
    return false;
  }
  if (String(process.env.LLAMA_GREETING_ENABLED || "").toLowerCase() === "true") {
    return true;
  }
  const cfg = getLlamaConfig();
  if (cfg.provider === "groq") return Boolean(cfg.apiKey);
  return false;
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
  return String(res.data?.message?.content || res.data?.response || "").trim();
}

async function callGroq({ model, prompt, apiKey, timeoutMs, system }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await axios.post(
    url,
    {
      model,
      temperature: 0.4,
      max_tokens: 120,
      messages,
    },
    {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );
  return String(res.data?.choices?.[0]?.message?.content || "").trim();
}

async function completeLlama({ system, prompt }) {
  if (!isLlamaConfigured()) return null;

  const cfg = getLlamaConfig();
  try {
    if (cfg.provider === "groq") {
      if (!cfg.apiKey) return null;
      return await callGroq({
        model: cfg.model,
        prompt,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
        system,
      });
    }
    return await callOllama({
      model: cfg.model,
      prompt,
      baseUrl: cfg.baseUrl,
      timeoutMs: cfg.timeoutMs,
      system,
    });
  } catch (error) {
    console.warn(`[LlamaClient] ${cfg.provider} call failed:`, error.message);
    return null;
  }
}

module.exports = {
  completeLlama,
  isLlamaConfigured,
  getLlamaConfig,
};
