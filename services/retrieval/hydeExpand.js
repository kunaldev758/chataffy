/**
 * HyDE — Hypothetical Document Embeddings
 * ---------------------------------------
 * Stage: runs AFTER pronoun/follow-up rewrite, BEFORE dense embedding.
 *
 * Idea (HyDE):
 *   Instead of embedding a short/vague user query alone, optionally generate a
 *   short "hypothetical ideal chunk" and embed (query + hypothetical text).
 *   That often lands closer to real knowledge-base chunks in vector space.
 *
 * Cost control:
 *   - Gated by ENABLE_HYDE env
 *   - Skipped when query was already rewritten (wasResolved) — avoid double LLM
 *   - Skipped for clear / long / non-informational queries
 *   - Hard timeout so HyDE never blocks the chat path
 *
 * Env:
 *   ENABLE_HYDE=true|false  (default: true)
 */

const { normalizeChatTurns } = require("./queryRewrite");

const DEFAULT_HYDE_TIMEOUT_MS = 2500;

/**
 * Routes / intents where a hypothetical document does not help retrieval.
 * Mapped from QueryRouter ROUTES + common aliases from test-backend.
 */
const SKIP_HYDE_INTENTS = new Set([
  "GREETING",
  "ACCIDENTAL",
  "ACKNOWLEDGEMENT",
  "LIVE_AGENT",
  "greeting",
  "contact",
  "vague",
]);

/**
 * True when HyDE is enabled via env (default on).
 * @returns {boolean}
 */
function isHydeEnabled() {
  const raw = (process.env.ENABLE_HYDE || "true").toLowerCase().trim();
  return !(raw === "false" || raw === "0" || raw === "off");
}

/**
 * Decide whether HyDE should run for this query.
 *
 * @param {string} query
 * @param {Array} [chatHistory] - unused today; kept for API parity / future rules
 * @param {string} [intent] - routing.route or subIntent
 * @param {object} [options]
 * @param {boolean} [options.wasResolved] - true if pronoun rewrite already fixed the query
 * @returns {boolean}
 */
function shouldRunHyDE(query, chatHistory = [], intent = "general", options = {}) {
  if (!isHydeEnabled()) {
    console.log("[HyDE] Skipped — ENABLE_HYDE is off");
    return false;
  }

  // Pronoun rewrite already produced a standalone query; HyDE adds cost with little gain.
  if (options && options.wasResolved) {
    console.log("[HyDE] Skipped — query already rewritten/resolved");
    return false;
  }

  const intentKey = String(intent || "general");
  if (SKIP_HYDE_INTENTS.has(intentKey)) {
    console.log(`[HyDE] Skipped — intent "${intentKey}" does not need expansion`);
    return false;
  }

  const trimmed = (query || "").trim();
  if (!trimmed) return false;

  // User is correcting the bot — don't invent a hypothetical "right" document.
  if (/\b(wrong|incorrect|invalid|error|showing the wrong|not right)\b/i.test(trimmed)) {
    console.log("[HyDE] Skipped — correction / feedback message");
    return false;
  }

  // Direct entities (URL/email/phone) are already precise retrieval keys.
  if (/https?:\/\/|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d{10,}/.test(trimmed)) {
    console.log("[HyDE] Skipped — query contains direct entities (url/email/phone)");
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Short vague queries benefit most from hypothetical expansion.
  if (wordCount <= 3) {
    console.log(`[HyDE] Triggered — short vague query (${wordCount} words)`);
    return true;
  }

  if (/\b(it|this|that|they|them|its|their|these|those|there)\b/i.test(trimmed)) {
    console.log("[HyDE] Triggered — ambiguous pronoun reference");
    return true;
  }

  // Broad catalog discovery — HyDE helps surface collection/product language.
  if (
    /\b(catalog|catalogs|collection|collections|category|categories|what do you sell|what do you offer|what do you provide|all products)\b/i.test(
      trimmed,
    )
  ) {
    console.log("[HyDE] Triggered — catalog / collection discovery query");
    return true;
  }

  console.log(
    `[HyDE] Skipped — query is clear enough (${wordCount} words)`,
  );
  return false;
}

/**
 * Cheap chat completion with timeout (same pattern as queryRewrite).
 *
 * @param {object} params
 * @returns {Promise<{ text: string, usage: object|null }>}
 */
async function callCheapChatWithTimeout({
  openaiClient,
  modelName,
  messages,
  maxTokens = 100,
  timeoutMs = DEFAULT_HYDE_TIMEOUT_MS,
}) {
  if (!openaiClient || !modelName) {
    return { text: "", usage: null };
  }

  const llmPromise = openaiClient.chat.completions
    .create({
      model: modelName,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
    })
    .then((response) => ({
      text: String(response.choices?.[0]?.message?.content || "").trim(),
      usage: response.usage || null,
    }))
    .catch((err) => {
      console.warn(`[HyDE] LLM call failed: ${err.message}`);
      return { text: "", usage: null };
    });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ text: "", usage: null }), timeoutMs),
  );

  return Promise.race([llmPromise, timeoutPromise]);
}

/**
 * Generate optional HyDE text and build the dense-embedding query string.
 *
 * @param {string} query - Standalone search query (post-rewrite preferred)
 * @param {Array<object>} chatHistory
 * @param {object} [options]
 * @param {string} [options.intent]
 * @param {boolean} [options.wasResolved]
 * @param {import("openai").OpenAI} [options.openaiClient]
 * @param {string} [options.modelName]
 * @param {Function} [options.logOpenAIUsage]
 * @returns {Promise<{ originalQuery: string, hydeText: string, expandedQuery: string }>}
 */
async function generateHyDEAndExpandQuery(query, chatHistory = [], options = {}) {
  const trimmed = (query || "").trim();
  const intent = options.intent || "general";

  // Light synonym expansion for catalog wording (zero LLM cost).
  let baseExpandedQuery = trimmed;
  if (/\b(catalog|catalogs)\b/i.test(trimmed)) {
    baseExpandedQuery = `${trimmed} collections categories products apparel items`;
  }

  if (!shouldRunHyDE(trimmed, chatHistory, intent, options)) {
    return {
      originalQuery: trimmed,
      hydeText: "",
      expandedQuery: baseExpandedQuery,
    };
  }

  const turns = normalizeChatTurns(chatHistory);
  const recentHistory = turns
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const systemInstruction = `You are an expert search context generator implementing HyDE (Hypothetical Document Embeddings).
Given a user query and recent chat context, generate a hypothetical 1-2 sentence target snippet of what a perfect answer/document chunk in a knowledge base would look like.
Focus on domain terminology, facts, and relevant descriptions.
Do NOT invent fake contact info or unverified prices.
Do NOT output greetings, preamble, or meta-comments. Output ONLY the raw hypothetical document snippet.`;

  const userPrompt = recentHistory
    ? `Recent Context:\n${recentHistory}\n\nUser Query: ${trimmed}\n\nHypothetical Document Snippet:`
    : `User Query: ${trimmed}\n\nHypothetical Document Snippet:`;

  const { openaiClient, modelName, logOpenAIUsage } = options;

  try {
    const result = await callCheapChatWithTimeout({
      openaiClient,
      modelName,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 100,
    });

    if (result.usage && typeof logOpenAIUsage === "function") {
      Promise.resolve(
        logOpenAIUsage({
          usage: result.usage,
          modelName,
          type: "intent",
        }),
      ).catch(() => {});
    }

    const cleanHyDE = result.text;
    // Dense query = original + hypothetical snippet (HyDE paper pattern).
    const expandedQuery = cleanHyDE
      ? `${trimmed}\n\n${cleanHyDE}`
      : baseExpandedQuery;

    console.log(
      `[HyDE] Generated snippet for "${trimmed}" (${cleanHyDE.length} chars)`,
    );

    return {
      originalQuery: trimmed,
      hydeText: cleanHyDE,
      expandedQuery,
    };
  } catch (error) {
    console.warn(
      `[HyDE] Generation failed, using original query: ${error.message}`,
    );
    return {
      originalQuery: trimmed,
      hydeText: "",
      expandedQuery: baseExpandedQuery || trimmed,
    };
  }
}

module.exports = {
  shouldRunHyDE,
  generateHyDEAndExpandQuery,
  isHydeEnabled,
};
