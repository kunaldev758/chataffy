const axios = require("axios");

/**
 * Thin client for Jina AI's Reranker API (https://api.jina.ai/v1/rerank).
 *
 * Kept intentionally dumb: takes a query + list of document strings, returns
 * `{ index, score }` pairs sorted by relevance. All chataffy-specific logic
 * (which field to use as document text, candidate limits, fallback behavior)
 * lives in ../index.js so this file can be swapped for another provider
 * (Cohere, Voyage, a self-hosted cross-encoder, etc.) without touching callers.
 */

const JINA_RERANK_URL = "https://api.jina.ai/v1/rerank";
const DEFAULT_MODEL = process.env.JINA_RERANKER_MODEL || "jina-reranker-v3.5";
const DEFAULT_TIMEOUT_MS = Number(process.env.JINA_RERANKER_TIMEOUT_MS) || 8000;

/**
 * @param {object} params
 * @param {string} params.query - Search query to rerank documents against.
 * @param {string[]} params.documents - Candidate document texts, in original order.
 * @param {number} [params.topN] - Max number of results to return (defaults to all).
 * @param {string} [params.model] - Override the Jina model name.
 * @returns {Promise<{index: number, score: number}[]>} Results sorted by descending relevance.
 */
async function rerank({ query, documents, topN, model }) {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) {
    throw new Error("JINA_API_KEY is not set");
  }
  if (!query || !Array.isArray(documents) || documents.length === 0) {
    return [];
  }

  const response = await axios.post(
    JINA_RERANK_URL,
    {
      model: model || DEFAULT_MODEL,
      query,
      documents,
      top_n: topN || documents.length,
      return_documents: false,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );

  const results = response.data?.results;
  if (!Array.isArray(results)) {
    throw new Error("Unexpected response shape from Jina rerank API");
  }

  return results.map((r) => ({
    index: r.index,
    score: r.relevance_score,
  }));
}

module.exports = {
  rerank,
  PROVIDER_NAME: "jina",
  DEFAULT_MODEL,
};
