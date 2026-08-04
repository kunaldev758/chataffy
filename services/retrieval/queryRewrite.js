/**
 * Contextual Query Rewrite (Pronoun / Follow-up Resolution)
 * ---------------------------------------------------------
 * Stage: runs AFTER light heuristic expansion (expandQueryForRetrieval)
 * and BEFORE HyDE / embedding.
 *
 * Why this exists:
 *   Short follow-ups like "price?", "link?", "what about the black one?"
 *   lack the product/entity from prior turns. Embedding those raw strings
 *   retrieves the wrong chunks. This module rewrites them into standalone
 *   search queries ("Acme Lash 14mm price").
 *
 * Strategy (cheap → expensive):
 *   1. Fast guard — skip rewrite when the query is already self-contained.
 *   2. Fast entity extract — pull product names from recent assistant HTML/markdown.
 *   3. LLM rewrite — cheap model with a hard timeout; never block the chat path.
 *
 * Env:
 *   ENABLE_QUERY_REWRITE=true|false  (default: true)
 */

const DEFAULT_REWRITE_TIMEOUT_MS = 2500;

/**
 * Normalize ChatMessage docs ({ sender_type, message }) or plain
 * { role, content } turns into a common shape for rewrite/HyDE.
 *
 * @param {Array<object>} chatHistory
 * @returns {Array<{ role: string, content: string }>}
 */
function normalizeChatTurns(chatHistory = []) {
  return (chatHistory || [])
    .map((msg) => {
      if (!msg) return null;

      // Already in OpenAI-style shape
      if (msg.role && (msg.content != null || msg.message != null)) {
        const role =
          msg.role === "assistant" || msg.role === "ai" || msg.role === "bot"
            ? "assistant"
            : msg.role === "system"
              ? "system"
              : "user";
        return {
          role,
          content: String(msg.content ?? msg.message ?? "").trim(),
        };
      }

      // ChatMessage mongoose docs used by QueryController
      const senderType = msg.sender_type || "";
      const role =
        senderType === "ai" ||
        senderType === "bot" ||
        senderType === "assistant"
          ? "assistant"
          : senderType === "system"
            ? "system"
            : "user";

      return {
        role,
        content: String(msg.message || msg.content || "").trim(),
      };
    })
    .filter((t) => t && t.content.length > 0);
}

/**
 * Strip HTML so entity regexes can run on plain text.
 * Keeps link labels from <a>...</a> for product-name extraction.
 *
 * @param {string} htmlOrText
 * @returns {string}
 */
function stripHtmlPreserveLinks(htmlOrText) {
  return String(htmlOrText || "")
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, " [$1](link) ")
    .replace(/<\/?(strong|b|em|i)[^>]*>/gi, "**")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headers / UI labels that look bold but are not product entities.
 */
const GENERIC_ENTITY_BLOCKLIST =
  /^(Key Features|Colors Available|Sizes Available|Price|Description|Key Differences|About page|About Us|Contact Us|Home|Header|Footer|Note|Warning|Source)$/i;

/**
 * Tier-1 fast path: find a recent product/entity mention in assistant replies.
 * Prefers markdown bold (**Name**) and markdown/HTML link labels.
 *
 * @param {Array<{ role: string, content: string }>} recentHistory
 * @returns {string}
 */
function extractExplicitEntity(recentHistory = []) {
  let explicitEntity = "";

  for (const msg of [...recentHistory].reverse()) {
    if (!msg || msg.role !== "assistant" || !msg.content) continue;
    const plain = stripHtmlPreserveLinks(msg.content);

    const boldMatch = plain.match(/\*\*([^*]{2,60})\*\*/);
    if (boldMatch) {
      const candidate = boldMatch[1]
        .replace(/^(Title:|Product:|\s)+/i, "")
        .trim();
      if (candidate && !GENERIC_ENTITY_BLOCKLIST.test(candidate)) {
        explicitEntity = candidate;
        break;
      }
    }

    const linkMatch = plain.match(/\[([^\]]{2,60})\]\(/);
    if (linkMatch) {
      const candidate = linkMatch[1]
        .replace(/^(here|link|website|view|\s)+/i, "")
        .trim();
      if (
        candidate.length > 2 &&
        !/^(here|link|website|view|about|contact|home)$/i.test(candidate)
      ) {
        explicitEntity = candidate;
        break;
      }
    }
  }

  return explicitEntity;
}

/**
 * True when env explicitly disables query rewrite.
 * @returns {boolean}
 */
function isQueryRewriteEnabled() {
  const raw = (process.env.ENABLE_QUERY_REWRITE || "true").toLowerCase().trim();
  return !(raw === "false" || raw === "0" || raw === "off");
}

/**
 * Call a cheap chat model with a hard timeout so rewrite never stalls retrieval.
 *
 * @param {object} params
 * @param {import("openai").OpenAI} params.openaiClient
 * @param {string} params.modelName
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {number} [params.maxTokens]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ text: string, usage: object|null }>}
 */
async function callCheapChatWithTimeout({
  openaiClient,
  modelName,
  messages,
  maxTokens = 40,
  timeoutMs = DEFAULT_REWRITE_TIMEOUT_MS,
}) {
  if (!openaiClient || !modelName) {
    return { text: "", usage: null };
  }

  const llmPromise = openaiClient.chat.completions
    .create({
      model: modelName,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
    })
    .then((response) => ({
      text: String(response.choices?.[0]?.message?.content || "").trim(),
      usage: response.usage || null,
    }))
    .catch((err) => {
      console.warn(
        `[queryRewrite] LLM call failed: ${err.message}`,
      );
      return { text: "", usage: null };
    });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ text: "", usage: null, timedOut: true }), timeoutMs),
  );

  return Promise.race([llmPromise, timeoutPromise]);
}

/**
 * Rewrite ambiguous follow-ups / pronouns into a standalone search query.
 *
 * @param {string} query - Current user query (preferably already normalized / lightly expanded)
 * @param {Array<object>} chatHistory - ChatMessage docs or {role,content} turns
 * @param {object} [options]
 * @param {import("openai").OpenAI} [options.openaiClient]
 * @param {string} [options.modelName]
 * @param {Function} [options.logOpenAIUsage] - async ({ usage, modelName, type }) => void
 * @returns {Promise<{ resolvedQuery: string, wasResolved: boolean, source: string }>}
 */
async function resolveAmbiguousPronouns(query, chatHistory = [], options = {}) {
  const trimmed = (query || "").trim();

  // Env kill-switch — keep retrieval working even if rewrite is disabled.
  if (!isQueryRewriteEnabled()) {
    console.log("[queryRewrite] Skipped — ENABLE_QUERY_REWRITE is off");
    return { resolvedQuery: trimmed, wasResolved: false, source: "disabled" };
  }

  if (!trimmed || !chatHistory || chatHistory.length === 0) {
    return { resolvedQuery: trimmed, wasResolved: false, source: "no_history" };
  }

  const turns = normalizeChatTurns(chatHistory);
  if (turns.length === 0) {
    return { resolvedQuery: trimmed, wasResolved: false, source: "no_history" };
  }

  // --- Fast guard: only rewrite when the query likely depends on prior context ---
  const hasPronouns =
    /\b(it|this|that|they|them|its|their|these|those|the product|the item)\b/i.test(
      trimmed,
    );
  const isImplicitRequest =
    /^(give me the link|give link|link|show link|url|website link|where to buy|how to buy|what is the price|price|cost|is it in stock|buy link)\b/i.test(
      trimmed,
    );
  const isObjection =
    /\b(wrong|incorrect|not have|does not have|doesn't have|how can you say)\b/i.test(
      trimmed,
    );
  // Standalone questions with a clear subject usually do not need rewrite.
  const isStandaloneQuestion =
    /^(what|where|who|why|how do|how can|do you|can you|is there|are there|tell me)\b/i.test(
      trimmed,
    ) && !hasPronouns;
  const isShortFragment =
    trimmed.split(/\s+/).length <= 4 && !isStandaloneQuestion;

  const needsResolution =
    (hasPronouns || isImplicitRequest || isObjection || isShortFragment) &&
    !isStandaloneQuestion;

  if (!needsResolution) {
    return {
      resolvedQuery: trimmed,
      wasResolved: false,
      source: "self_contained",
    };
  }

  const recentHistory = turns.slice(-4);
  const explicitEntity = extractExplicitEntity(recentHistory);

  // --- Tier 1: zero-cost rewrite when we already know the entity ---
  if (explicitEntity && (hasPronouns || isImplicitRequest || isShortFragment)) {
    const cleanFollowUp = trimmed
      .replace(
        /\b(it|this|that|they|them|its|their|these|those|the product|the item)\b/gi,
        "",
      )
      .trim();
    let resolved = `${explicitEntity} ${cleanFollowUp}`.trim();

    // Spec / feature follow-ups benefit from extra lexical anchors for hybrid search.
    if (
      /\b(feature|features|spec|specs|specification|specifications|material|fabric)\b/i.test(
        trimmed,
      )
    ) {
      resolved =
        `${explicitEntity} specifications features material fabric details ${cleanFollowUp}`.trim();
    }

    console.log(
      `[queryRewrite] Fast path: "${trimmed}" → "${resolved}" (entity="${explicitEntity}")`,
    );
    return {
      resolvedQuery: resolved,
      wasResolved: true,
      source: "fast_entity",
    };
  }

  // --- Tier 2: cheap LLM rewrite with timeout ---
  const { openaiClient, modelName, logOpenAIUsage } = options;
  if (openaiClient && modelName) {
    try {
      const historyText = recentHistory
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");

      const systemPrompt = `You are a Contextual Query Rewriter for search engines.
Given the recent chat history and a user's follow-up query, rewrite the user query into a single, clear, self-contained search query.
- Replace ambiguous pronouns ("it", "this", "that") and implicit references with the exact product name or subject from the chat history.
- If the user is asking for a link, price, or size, include the product name and requested attribute.
- Do NOT answer the question. Reply ONLY with the rewritten single-line search query.`;

      const userPrompt = `Chat History:\n${historyText}\n\nUser Query: "${trimmed}"\n\nStandalone Search Query:`;

      const result = await callCheapChatWithTimeout({
        openaiClient,
        modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 40,
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

      const cleanRewritten = result.text.replace(/^["']|["']$/g, "").trim();
      if (cleanRewritten && cleanRewritten !== trimmed) {
        console.log(
          `[queryRewrite] LLM path: "${trimmed}" → "${cleanRewritten}"`,
        );
        return {
          resolvedQuery: cleanRewritten,
          wasResolved: true,
          source: "llm",
        };
      }
    } catch (err) {
      console.warn(
        `[queryRewrite] LLM rewriter error, falling back: ${err.message}`,
      );
    }
  }

  // --- Fallback: prepend last known entity if we have one ---
  if (explicitEntity) {
    const fallbackResolved = `${explicitEntity} ${trimmed}`.trim();
    console.log(
      `[queryRewrite] Entity fallback: "${trimmed}" → "${fallbackResolved}"`,
    );
    return {
      resolvedQuery: fallbackResolved,
      wasResolved: true,
      source: "entity_fallback",
    };
  }

  return { resolvedQuery: trimmed, wasResolved: false, source: "unchanged" };
}

module.exports = {
  resolveAmbiguousPronouns,
  normalizeChatTurns,
  stripHtmlPreserveLinks,
  extractExplicitEntity,
  isQueryRewriteEnabled,
};
