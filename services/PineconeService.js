require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");


class VectorStoreManager {
  constructor(pineconeIndexName) {
    this.pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      maxRetries: 5,
    });

    this.pineconeIndex = this.pineconeClient.index(pineconeIndexName);

    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

generateVectorId(chunk) {
  // Create a hash from the chunk text (can be customized if needed)
  return crypto.createHash('sha256').update(chunk).digest('hex');
}

  async upsertVectors(chunks, metadata) {
    try {
      const batchSize = 100;
      const upsertBatches = [];
      let vectorId = generateVectorId(chunks[0]);

      const embeddings = await this.embeddings.embedDocuments(chunks);

      const pageVectors = embeddings.map((embedding, i) => ({
        id: vectorId,
        values: embedding,
        metadata: {
          text: chunks[i],
          ...metadata,
          chunk_index: i,
          total_chunks: chunks.length,
        },
      }));

      for (let i = 0; i < pageVectors.length; i += batchSize) {
        upsertBatches.push(pageVectors.slice(i, i + batchSize));
      }

      console.log(
        `Upserting ${pageVectors.length} vectors in ${upsertBatches.length} batches`
      );

      for (let i = 0; i < upsertBatches.length; i++) {
        const batch = upsertBatches[i];
        await this.pineconeIndex.upsert(batch);
        console.log(`Upserted batch ${i + 1}/${upsertBatches.length}`);
      }

      return { success: true, vectorCount: pageVectors.length };
    } catch (error) {
      console.error("Error upserting vectors to Pinecone:", error);
      return { success: false, error };
    }
  }

  async doesIndexExist(pineconeIndexName) {
    try {
      const indexList = await this.pineconeClient.listIndexes();
      return indexList.indexes.some((index) => index.name === pineconeIndexName);
    } catch (error) {
      console.error("Error checking if index exists:", error);
      return false;
    }
  }

  async createIndex(pineconeIndexName) {
    try {
      let spec = {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      };

      await this.pineconeClient.createIndex({
        name: pineconeIndexName,
        dimension: 1536,
        metric: "cosine",
        spec: spec,
      });
      console.log(
        `Pinecone index "${this.pineconeIndexName}" created successfully.`
      );
      await this.waitForIndexCreation(pineconeIndexName);
      return true;
    } catch (error) {
      console.error(
        `Error creating Pinecone index "${this.pineconeIndexName}":`,
        error
      );
      return false;
    }
  }

  async waitForIndexCreation(pineconeIndexName, timeout = 60000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const indexDescription = await this.pineconeClient.describeIndex(
          pineconeIndexName
        );
        if (indexDescription.status.ready) {
          console.log(`Pinecone index "${pineconeIndexName}" is ready.`);
          return;
        }
      } catch (error) {
        console.warn(
          `Error describing index "${pineconeIndexName}", retrying...`,
          error.message
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `Timeout waiting for Pinecone index "${pineconeIndexName}" to be created.`
    );
  }
}


module.exports = VectorStoreManager;