class TrainingPricingCalculator {
    constructor() {
      this.rates = {
        embedding: {
          ada: 0.0001,
        },
        chatCompletion: {
          "gpt-3.5-turbo": {
            input: 0.001,
            output: 0.002,
          },
        },
        pinecone: {
          query: 0.0002,
          vector: 0.0002,
        },
      };
    }
  
    async estimateTokens(text) {
      return Math.ceil(text.length / 4);
    }
  
    calculateEmbeddingCost(tokens) {
      return (tokens / 1000) * this.rates.embedding.ada;
    }
  
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
  
    calculatePineconeQueryCost(queryCount) {
      return queryCount * this.rates.pinecone.query;
    }
  
    calculatePineconeStorageCost(ChunkLength) {
      return ChunkLength * this.rates.pinecone.vector;
    }
  }
  
  module.exports = TrainingPricingCalculator;