// services/UnifiedPricingService.js
const { encoding_for_model } = require("@dqbd/tiktoken"); // More accurate tokenizer

// --- Pricing Configuration ---
// (Ideally, load from a config file or environment variables for flexibility)

const OPENAI_PRICING = {
  embeddings: {
    'text-embedding-ada-002': 0.0001 / 1000, // Price per token
    'text-embedding-3-small': 0.00002 / 1000, // Price per token
    'text-embedding-3-large': 0.00013 / 1000, // Price per token
    'default': 0.00002 / 1000 // Fallback to a common/cheap model price
  },
  completions: {
    'gpt-3.5-turbo': {
      input: 0.0005 / 1000, // Price per token
      output: 0.0015 / 1000, // Price per token
    },
    'gpt-4': {
      input: 0.03 / 1000,
      output: 0.06 / 1000
    },
    'gpt-4-turbo': {
      input: 0.01 / 1000,
      output: 0.03 / 1000
    },
    'gpt-4o': {
      input: 0.005 / 1000,
      output: 0.015 / 1000
    },
     'default': { // Fallback
      input: 0.0005 / 1000,
      output: 0.0015 / 1000
    }
  }
};

const PINECONE_PRICING = {
  queries: {
    // Note: Pinecone pricing can be complex (per read unit, tier, pod type etc.)
    // This is a simplified model based on price per 1000 queries.
    // Adjust based on your specific Pinecone plan (starter, standard, enterprise) and pod type (p1, s1 etc.)
    'standard': { // Example tier
        's1': 0.0007 / 1000, // Price per query
        'default': 0.0007 / 1000
    },
     'starter': { // Example tier
        'p1': 0.002 / 1000, // Price per query
        'default': 0.002 / 1000
    },
    'default': 0.001 / 1000 // A generic fallback query price
  }
  // We are not calculating storage cost per operation here, as it's time-based.
};

// --- Tokenizer Setup ---
// Use a specific model for token counting, gpt-3.5/4 usually works well
// Cache the encoder for performance
let tokenizer;
try {
  tokenizer = encoding_for_model("gpt-4"); // Or "gpt-3.5-turbo"
} catch (e) {
  console.warn("Tiktoken model not found, using approximation for token count.", e);
  tokenizer = null;
}


class UnifiedPricingService {
  constructor(pineconeTier = 'standard', pineconePodType = 's1') {
    // You might want to pass the user's specific Pinecone plan details here
    this.pineconeTier = pineconeTier;
    this.pineconePodType = pineconePodType;
    this.creditsPerDollar = 10; // Example conversion rate: 1 dollar = 10 credits
    console.log(`Pricing Service initialized for Pinecone Tier: ${this.pineconeTier}, Pod: ${this.pineconePodType}`);
  }

  /**
   * Estimates the number of tokens for a given text.
   * Uses tiktoken if available, otherwise falls back to approximation.
   * @param {string} text - The text to estimate tokens for.
   * @returns {number} - The estimated number of tokens.
   */
  estimateTokens(text) {
    if (!text) return 0;
    if (tokenizer) {
      try {
        return tokenizer.encode(text).length;
      } catch (e) {
        console.warn("Tiktoken encoding failed, falling back to approximation.", e);
        // Fallback to approximation if encoding fails for some reason
        return Math.ceil(text.length / 4);
      }
    } else {
      // Simple approximation: 1 token ~ 4 characters
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Calculates the cost of generating OpenAI embeddings.
   * @param {number} tokens - The number of tokens.
   * @param {string} [modelName='text-embedding-3-small'] - The embedding model used.
   * @returns {number} - The calculated embedding cost.
   */
  calculateEmbeddingCost(tokens, modelName = 'text-embedding-3-small') {
    const rate = OPENAI_PRICING.embeddings[modelName] || OPENAI_PRICING.embeddings['default'];
    if (!rate) {
        console.warn(`Warning: Embedding price not found for model ${modelName}. Using default.`);
        return tokens * OPENAI_PRICING.embeddings['default'];
    }
    return tokens * rate;
  }

  /**
   * Calculates the cost of an OpenAI chat completion.
   * @param {number} inputTokens - The number of input tokens.
   * @param {number} outputTokens - The number of output tokens.
   * @param {string} [modelName='gpt-3.5-turbo'] - The completion model used.
   * @returns {number} - The calculated completion cost.
   */
  calculateChatCompletionCost(inputTokens, outputTokens, modelName = 'gpt-3.5-turbo') {
    const modelPrices = OPENAI_PRICING.completions[modelName] || OPENAI_PRICING.completions['default'];
     if (!modelPrices) {
        console.warn(`Warning: Completion price not found for model ${modelName}. Using default.`);
        const defaultPrices = OPENAI_PRICING.completions['default'];
        return (inputTokens * defaultPrices.input) + (outputTokens * defaultPrices.output);
    }
    const inputCost = inputTokens * modelPrices.input;
    const outputCost = outputTokens * modelPrices.output;
    return inputCost + outputCost;
  }

  /**
   * Calculates the cost of querying Pinecone.
   * @param {number} [queryCount=1] - The number of queries made.
   * @returns {number} - The calculated query cost.
   */
  calculatePineconeQueryCost(queryCount = 1) {
    const tierRates = PINECONE_PRICING.queries[this.pineconeTier] || {};
    const rate = tierRates[this.pineconePodType] || tierRates['default'] || PINECONE_PRICING.queries['default'];
    if (!rate) {
         console.warn(`Warning: Pinecone query price not found for tier ${this.pineconeTier} / pod ${this.pineconePodType}. Using generic default.`);
         return queryCount * PINECONE_PRICING.queries['default'];
    }
    return queryCount * rate;
  }

  // --- NEW METHOD: dollarsToCredits ---
  /**
   * Converts a dollar amount to the equivalent number of credits.
   * @param {number} dollarAmount - The cost in US dollars.
   * @returns {number} - The calculated credits (rounded up to the nearest integer).
   */
  dollarsToCredits(dollarAmount) {
    if (dollarAmount <= 0) {
        return 0;
    }
    // Ensure creditsPerDollar is a positive number to avoid division by zero or negative credits
    const conversionRate = this.creditsPerDollar > 0 ? this.creditsPerDollar : DEFAULT_CREDITS_PER_DOLLAR;
    // Round up to ensure even tiny costs consume at least 1 credit if applicable, and avoid fractional credits.
    return Math.ceil(dollarAmount * conversionRate);
}

 // --- NEW METHOD: calculateOperationCost ---
  /**
   * Calculates the total cost for a given operation based on provided details.
   * @param {object} details - Object containing metrics for the operation.
   * @param {number} [details.embeddingTokens=0] - Tokens used for embeddings.
   * @param {string} [details.embeddingModel=DEFAULT_EMBEDDING_MODEL] - Embedding model used.
   * @param {number} [details.promptTokens=0] - Input tokens for chat completion.
   * @param {number} [details.completionTokens=0] - Output tokens for chat completion.
   * @param {string} [details.completionModel=DEFAULT_CHAT_MODEL] - Chat completion model used.
   * @param {number} [details.pineconeQueries=0] - Number of Pinecone queries performed.
   * @returns {{totalCost: number, breakdown: object}} - Object with total cost and breakdown by category.
   */
  calculateOperationCost(details = {}) {
  

    const embeddingCost = this.calculateEmbeddingCost(details.embeddingTokens || 0, details.embeddingModel);

    const completionCost = this.calculateChatCompletionCost(
        details.promptTokens || 0,
        details.completionTokens || 0,
        details.completionModel // Use provided model or default inside function
    );

    const pineconeCost = this.calculatePineconeQueryCost(
        details.pineconeQueries || 0
    );
    // Add other cost calculations here if needed (e.g., image generation, function calls)
    // const imageCost = this.calculateImageCost(...)
    // const functionCallCost = this.calculateFunctionCallCost(...)
    const totalCost = embeddingCost + completionCost + pineconeCost; // + imageCost + functionCallCost...

    const breakdown = {
        embeddingCost,
        completionCost,
        pineconeCost,
         // imageCost,
         // functionCallCost,
    };

    return {
        totalCost,
        breakdown,
    };
}
}

// Cleanup tokenizer on exit (optional but good practice)
process.on('exit', () => {
  if (tokenizer) {
    tokenizer.free();
  }
});


module.exports = UnifiedPricingService;