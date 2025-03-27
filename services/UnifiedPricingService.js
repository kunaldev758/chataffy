/**
 * UnifiedPricingService.js
 * Centralizes all pricing calculations for the application
 */
class UnifiedPricingService {
    constructor() {
      // Define all pricing rates in a single place
      this.rates = {
        embedding: {
          ada: 0.0001, // per 1K tokens
        },
        chatCompletion: {
          "gpt-3.5-turbo": {
            input: 0.001,  // per 1K tokens
            output: 0.002, // per 1K tokens
          },
          // Add other models as needed
        },
        pinecone: {
          query: 0.0002,  // per query
          vector: 0.0002, // per vector storage
        },
        // Credit conversion rate
        creditRate: 10, // 1 dollar = 10 credits
      };
    }
  
    /**
     * Estimates token count from text
     * @param {string} text - The text to estimate tokens for
     * @returns {number} - Estimated token count
     */
    async estimateTokens(text) {
      // Simple estimation: ~4 characters per token
      return Math.ceil(text.length / 4);
    }
  
    /**
     * Calculates embedding cost
     * @param {number} tokens - Number of tokens
     * @param {string} model - Embedding model (default: ada)
     * @returns {number} - Cost in dollars
     */
    calculateEmbeddingCost(tokens, model = "ada") {
      return (tokens / 1000) * this.rates.embedding[model];
    }
  
    /**
     * Calculates chat completion cost
     * @param {number} inputTokens - Number of input tokens
     * @param {number} outputTokens - Number of output tokens
     * @param {string} model - Model used (default: gpt-3.5-turbo)
     * @returns {number} - Cost in dollars
     */
    calculateChatCompletionCost(
      inputTokens,
      outputTokens,
      model = "gpt-3.5-turbo"
    ) {
      const inputCost =
        (inputTokens / 1000) * this.rates.chatCompletion[model].input;
      const outputCost =
        (outputTokens / 1000) * this.rates.chatCompletion[model].output;
      return inputCost + outputCost;
    }
  
    /**
     * Calculates Pinecone query cost
     * @param {number} queryCount - Number of queries
     * @returns {number} - Cost in dollars
     */
    calculatePineconeQueryCost(queryCount) {
      return queryCount * this.rates.pinecone.query;
    }
  
    /**
     * Calculates Pinecone storage cost
     * @param {number} chunkLength - Number of chunks/vectors
     * @returns {number} - Cost in dollars
     */
    calculatePineconeStorageCost(chunkLength) {
      return chunkLength * this.rates.pinecone.vector;
    }
  
    /**
     * Calculates total cost based on multiple factors
     * @param {Object} params - Parameters for calculation
     * @param {number} params.inputTokens - Number of input tokens
     * @param {number} params.outputTokens - Number of output tokens
     * @param {number} params.vectorCount - Number of vector operations
     * @param {number} params.embeddingTokens - Number of tokens for embedding
     * @param {number} params.pineconeChunks - Number of Pinecone chunks stored
     * @param {number} params.pineconeQueries - Number of Pinecone queries
     * @returns {Object} - Cost details in dollars
     */
    calculateTotalCost({
      inputTokens = 0,
      outputTokens = 0,
      vectorCount = 0,
      embeddingTokens = 0,
      pineconeChunks = 0,
      pineconeQueries = 0,
    } = {}) {
      const chatCost = this.calculateChatCompletionCost(inputTokens, outputTokens);
      const embeddingCost = this.calculateEmbeddingCost(embeddingTokens);
      const pineconeStorageCost = this.calculatePineconeStorageCost(pineconeChunks);
      const pineconeQueryCost = this.calculatePineconeQueryCost(pineconeQueries);
      
      const totalCost = chatCost + embeddingCost + pineconeStorageCost + pineconeQueryCost;
      
      return {
        chatCost,
        embeddingCost,
        pineconeStorageCost,
        pineconeQueryCost,
        totalCost,
      };
    }
  
    /**
     * Converts dollar amount to credits
     * @param {number} dollarAmount - Amount in dollars
     * @returns {number} - Amount in credits
     */
    dollarsToCredits(dollarAmount) {
      return Math.ceil(dollarAmount * this.rates.creditRate);
    }
  
    /**
     * Converts credits to dollar amount
     * @param {number} credits - Amount in credits
     * @returns {number} - Amount in dollars
     */
    creditsToDollars(credits) {
      return credits / this.rates.creditRate;
    }
  
    /**
     * Calculates required credits for an operation
     * @param {Object} costDetails - Cost details from calculateTotalCost
     * @returns {number} - Required credits
     */
    calculateRequiredCredits(costDetails) {
      return this.dollarsToCredits(
        typeof costDetails === 'number' 
          ? costDetails 
          : costDetails.totalCost
      );
    }
  }
  
  module.exports = UnifiedPricingService;