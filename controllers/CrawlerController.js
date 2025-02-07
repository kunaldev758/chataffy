require('dotenv').config();
const puppeteer = require('puppeteer');
const TurndownService = require('turndown');
const { MarkdownTextSplitter } = require('langchain/text_splitter');
const { Pinecone } = require('@pinecone-database/pinecone');
const { OpenAIEmbeddings } = require("@langchain/openai");
const { WebsiteScraper } = require('./ScraperFile');
const mongoose = require("mongoose");

class TrainingPricingCalculator {
    constructor() {
        // Current pricing rates (as of 2024)
        this.rates = {
            embedding: {
                ada: 0.0001 // per 1K tokens
            },
            pinecone: {
                storage: 0.0002 // per vector per month
            }
        };
    }

    async estimateTokens(text) {
        // Rough approximation: 1 token ≈ 4 characters
        return Math.ceil(text.length / 4);
    }

    calculateEmbeddingCost(tokens) {
        return (tokens / 1000) * this.rates.embedding.ada;
    }

    calculatePineconeStorageCost(vectorCount, months = 1) {
        return vectorCount * this.rates.pinecone.storage * months;
    }
}

// Usage Schema for cost tracking
const TrainingUsageSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    operation: { type: String, required: true }, // 'embedding', 'pinecone_storage'
    details: {
        totalTokens: Number,
        vectorCount: Number,
        cost: Number
    }
});

const TrainingUsage = mongoose.model('TrainingUsage', TrainingUsageSchema);


async function scrapeWebsite(url) {
    const scraper = new WebsiteScraper();
    const results = await scraper.scrapeWebsite(url);
    return results;
}


async function train(scrapedData) {
    const pricingCalculator = new TrainingPricingCalculator();
    const costs = {
        embedding: 0,
        pineconeStorage: 0,
        total: 0
    };
    try {
        // Initialize text splitter
        const textSplitter = new MarkdownTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 20,
        });

        // Initialize embedding model
        const embeddingModel = new OpenAIEmbeddings({ 
            openAIApiKey: process.env.OPENAI_API_KEY 
        });

        // Initialize Pinecone client
        const client = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY,
            maxRetries: 5,
        });

        const index = client.index(process.env.PINECONE_INDEX_NAME);

        // Process each scraped page
        let vectorId = 0;
        let totalTokens = 0;
        const batchSize = 100; // Adjust based on your needs
        const upsertBatches = [];

        for (const page of scrapedData) {
            // Ensure we're working with a valid page object
            if (!page.content || typeof page.content !== 'string') {
                console.warn(`Skipping invalid page:`, page);
                continue;
            }

            // Split the content into chunks
            const chunks = await textSplitter.splitText(page.content);

             // Calculate tokens and embedding cost for this page
             for (const chunk of chunks) {
                const chunkTokens = await pricingCalculator.estimateTokens(chunk);
                totalTokens += chunkTokens;
            }

            // Create embeddings for chunks
            const embeddings = await embeddingModel.embedDocuments(chunks);

            // Create upsert objects with metadata
            const pageVectors = embeddings.map((embedding, i) => ({
                id: `vec${vectorId + i}`,
                values: embedding,
                metadata: {
                    text: chunks[i],
                    url: page.url,
                    chunk_index: i,
                    total_chunks: chunks.length
                }
            }));

            vectorId += chunks.length;

            // Add vectors to batches
            for (let i = 0; i < pageVectors.length; i += batchSize) {
                upsertBatches.push(pageVectors.slice(i, i + batchSize));
            }
        }

          // Calculate costs
          costs.embedding = pricingCalculator.calculateEmbeddingCost(totalTokens);
          costs.pineconeStorage = pricingCalculator.calculatePineconeStorageCost(vectorId);
          costs.total = costs.embedding + costs.pineconeStorage;
  
          // Track usage
          await TrainingUsage.create({
              operation: 'embedding',
              details: {
                  totalTokens,
                  vectorCount: vectorId,
                  cost: costs.embedding
              }
          });
  
          await TrainingUsage.create({
              operation: 'pinecone_storage',
              details: {
                  vectorCount: vectorId,
                  cost: costs.pineconeStorage
              }
          });

        // Upsert batches to Pinecone
        console.log(`Upserting ${vectorId} vectors in ${upsertBatches.length} batches`);
        
        for (let i = 0; i < upsertBatches.length; i++) {
            const batch = upsertBatches[i];
            await index.upsert(batch);
            console.log(`Upserted batch ${i + 1}/${upsertBatches.length}`);
        }

        return {
            success: true,
            vectorsUpserted: vectorId,
            pagesProcessed: scrapedData.length,
            costs: {
                ...costs,
                details: {
                    totalTokens,
                    vectorCount: vectorId,
                    monthlyPineconeCost: costs.pineconeStorage
                }
            }
        };

    } catch (error) {
        console.error('Error in training:', error);
        throw new Error(`Training failed: ${error.message}`);
    }
}

// Function to get training cost summary
async function getTrainingCostSummary(startDate, endDate) {
    try {
        const usage = await TrainingUsage.aggregate([
            {
                $match: {
                    timestamp: { $gte: startDate, $lte: endDate }
                }
            },
            {
                $group: {
                    _id: '$operation',
                    totalCost: { $sum: '$details.cost' },
                    totalTokens: { $sum: '$details.totalTokens' },
                    totalVectors: { $sum: '$details.vectorCount' }
                }
            }
        ]);

        return {
            summary: usage,
            totalCost: usage.reduce((sum, item) => sum + item.totalCost, 0)
        };
    } catch (error) {
        console.error('Error getting training cost summary:', error);
        throw error;
    }
}

// Helper function to combine multiple scraped results into single training input
function prepareTrainingData(scrapedResults) {
    // If input is already an array, validate its structure
    if (Array.isArray(scrapedResults)) {
        return scrapedResults.map(result => {
            if (typeof result === 'string') {
                return { content: result, url: 'unknown' };
            }
            return result;
        });
    }
    
    // If input is a string, wrap it in the expected structure
    if (typeof scrapedResults === 'string') {
        return [{ content: scrapedResults, url: 'unknown' }];
    }

    throw new Error('Invalid input format: Expected string or array of objects with content property');
}



module.exports = {scrapeWebsite, train,prepareTrainingData,getTrainingCostSummary}