/**
 * prepareRetrievalQuery — Query preparation orchestrator
 * ------------------------------------------------------
 * Single entry point used by QueryController.getAnswer before embedding.
 *
 * Pipeline order (do not reorder without reason):
 *   1. Pick base query (router translation → heuristic expand → normalized)
 *   2. Pronoun / follow-up rewrite  → lexicalQuery (good for BM25 / sparse / keywords)
 *   3. Optional HyDE expansion     → embeddingQuery (good for dense vectors)
 *
 * This module does NOT:
 *   - Call Qdrant
 *   - Rerank candidates
 *   - Generate the final chat answer
 *
 * Env:
 *   ENABLE_QUERY_REWRITE  (default true) — see queryRewrite.js
 *   ENABLE_HYDE           (default true) — see hydeExpand.js
 *   OPENAI_RETRIEVAL_REWRITE_MODEL — optional override for rewrite/HyDE model
 */

const { resolveAmbiguousPronouns } = require("./queryRewrite");
const { generateHyDEAndExpandQuery } = require("./hydeExpand");

/**
 * Resolve which cheap model to use for rewrite + HyDE.
 * Prefer an explicit retrieval model, then router nano, then brief chat.
 *
 * @param {string} [explicitModel]
 * @returns {string}
 */
function resolveRewriteModel(explicitModel) {
  return (
    explicitModel ||
    process.env.OPENAI_RETRIEVAL_REWRITE_MODEL ||
    process.env.OPENAI_ROUTER_MODEL ||
    process.env.OPENAI_CHAT_MODEL_BRIEF ||
    "gpt-4.1-nano"
  );
}

/**
 * Prepare lexical + dense embedding query strings for hybrid retrieval.
 *
 * @param {object} params
 * @param {string} params.normalizedQuestion - Light-normalized visitor question
 * @param {string} params.retrievalQuery - From expandQueryForRetrieval()
 * @param {Array<object>} params.chatHistory - ChatMessage docs for this conversation
 * @param {object} [params.routing] - From routeQuery()
 * @param {import("openai").OpenAI} [params.openaiClient]
 * @param {string} [params.modelName]
 * @param {Function} [params.logOpenAIUsage] - ({ usage, modelName, type }) => Promise|void
 * @returns {Promise<{
 *   originalQuestion: string,
 *   baseQuery: string,
 *   lexicalQuery: string,
 *   embeddingQuery: string,
 *   wasResolved: boolean,
 *   rewriteSource: string,
 *   hydeText: string,
 *   modelName: string,
 * }>}
 */
async function prepareRetrievalQuery({
  normalizedQuestion,
  retrievalQuery,
  chatHistory = [],
  routing = {},
  openaiClient = null,
  modelName = null,
  logOpenAIUsage = null,
} = {}) {
  const originalQuestion = (normalizedQuestion || "").trim();

  // Prefer router-translated query (same language as indexed chunks),
  // then heuristic expansion, then the normalized visitor text.
  const baseQuery = (
    routing.rewrittenQuery ||
    retrievalQuery ||
    originalQuestion
  ).trim();

  const resolvedModel = resolveRewriteModel(modelName);
  const llmOptions = {
    openaiClient,
    modelName: resolvedModel,
    logOpenAIUsage,
  };

  // Intent string for HyDE skip rules (route is more stable than subIntent).
  const intent = routing.route || routing.subIntent || "SEMANTIC_RAG";

  console.log(
    `[prepareRetrievalQuery] base="${baseQuery.substring(0, 80)}" intent=${intent}`,
  );

  console.log("prepare retrieval query: chatHistory.length=", chatHistory.length);

  // --- Step 1: Pronoun / follow-up rewrite ---
  const rewriteResult = await resolveAmbiguousPronouns(
    baseQuery,
    chatHistory,
    llmOptions,
  );


  console.log("rewrite query result check : ", rewriteResult);

  const lexicalQuery = (rewriteResult.resolvedQuery || baseQuery).trim();
  const wasResolved = Boolean(rewriteResult.wasResolved);

  // --- Step 2: Optional HyDE (skipped automatically when wasResolved) ---
  const hydeResult = await generateHyDEAndExpandQuery(
    lexicalQuery,
    chatHistory,
    {
      ...llmOptions,
      intent,
      wasResolved,
    },
  );


  console.log("hyde query result check : ", hydeResult);

  // Dense embedding: HyDE-expanded text when present; otherwise lexical query.
  // Lexical/sparse search keeps the shorter rewritten query (cleaner BM25 terms).
  const embeddingQuery = (
    hydeResult.hydeText
      ? hydeResult.expandedQuery
      : hydeResult.expandedQuery || lexicalQuery
  ).trim();

  console.log(
    `[prepareRetrievalQuery] rewrite=${wasResolved ? rewriteResult.source : "none"} ` +
      `hyde=${hydeResult.hydeText ? "yes" : "no"} ` +
      `lexical="${lexicalQuery.substring(0, 60)}" ` +
      `embedChars=${embeddingQuery.length}`,
  );


  console.log("final check before returning an result ",{
    originalQuestion,
    baseQuery,
    lexicalQuery,
    embeddingQuery,
    wasResolved,
    rewriteSource: rewriteResult.source || "none",
    hydeText: hydeResult.hydeText || "",
    modelName: resolvedModel,
  });

  return {
    originalQuestion,
    baseQuery,
    lexicalQuery,
    embeddingQuery,
    wasResolved,
    rewriteSource: rewriteResult.source || "none",
    hydeText: hydeResult.hydeText || "",
    modelName: resolvedModel,
  };
}

module.exports = {
  prepareRetrievalQuery,
  resolveRewriteModel,
};
