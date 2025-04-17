require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const crypto = require('crypto');

// Define the embedding model from environment or use a default
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
// Define the expected dimension for the chosen embedding model
// text-embedding-ada-002: 1536
// text-embedding-3-small: 1536
// text-embedding-3-large: 3072
const EMBEDDING_DIMENSION = parseInt(process.env.OPENAI_EMBEDDING_DIMENSION || '1536', 10);

class VectorStoreManager {
  constructor(pineconeIndexName) {
    if (!pineconeIndexName) {
      throw new Error("Pinecone index name must be provided to VectorStoreManager.");
    }
    this.pineconeIndexName = pineconeIndexName; // Store index name

    this.pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      maxRetries: 5,
    });

    // Initialize the index reference immediately
    this.pineconeIndex = this.pineconeClient.index(this.pineconeIndexName);

    // Initialize embeddings with the configured model
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: EMBEDDING_MODEL, // Use the configured model name
      // dimensions: EMBEDDING_DIMENSION // Optional: Specify dimensions if using model supporting it (e.g., v3 models)
                                       // Note: check Langchain docs if `dimensions` is the correct param name here
    });

    console.log(`VectorStoreManager initialized for index "${this.pineconeIndexName}" using embedding model "${EMBEDDING_MODEL}" (Dimension: ${EMBEDDING_DIMENSION})`);
  }

  /**
   * Generates a consistent ID for a vector based on its text content.
   * Uses SHA256 hashing.
   * @param {string} textContent - The text content of the chunk.
   * @returns {string} - The generated vector ID.
   */
  generateVectorId(textContent) {
    // Create a hash from the chunk text
    return crypto.createHash('sha256').update(textContent).digest('hex');
  }

  /**
   * Generates embeddings and upserts LangChain Document objects into the Pinecone index.
   * @param {Array<import("@langchain/core/documents").Document>} documents - An array of LangChain Document objects.
   * @returns {Promise<{success: boolean, vectorCount?: number, error?: any}>} - Result object.
   */
  async upsertDocuments(documents) {
    if (!documents || documents.length === 0) {
      console.log("No documents provided to upsert.");
      return { success: true, vectorCount: 0 };
    }

    try {
      const batchSize = 100; // Pinecone recommended batch size
      const upsertBatches = [];

      // 1. Extract page content for batch embedding
      const contents = documents.map(doc => doc.pageContent);

      // 2. Generate embeddings for all contents in batches if necessary (Langchain might handle internally)
      // Note: embedDocuments usually handles large inputs efficiently.
      console.log(`Generating embeddings for ${contents.length} document(s) using model ${EMBEDDING_MODEL}...`);
      const embeddings = await this.embeddings.embedDocuments(contents);
      console.log(`Successfully generated ${embeddings.length} embeddings.`);

      if (!embeddings || embeddings.length !== documents.length) {
        throw new Error(`Failed to generate embeddings or mismatch in count (Expected: ${documents.length}, Got: ${embeddings?.length})`);
      }

      // 3. Prepare Pinecone vector objects
      const vectors = documents.map((doc, i) => {
        // Ensure metadata exists and is an object
        const originalMetadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};

         // --- FILTERING STEP ---
        // Create a new object to store filtered metadata
        const filteredMetadata = {};
        for (const key in originalMetadata) {
          const value = originalMetadata[key];
          // Keep only keys where the value is a string, number, boolean, or null/undefined
          // You could also explicitly check for arrays of strings if needed:
          // Array.isArray(value) && value.every(item => typeof item === 'string')
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null ||
            typeof value === 'undefined' ||
             // Explicitly allow arrays of strings (common for tags)
            (Array.isArray(value) && value.every(item => typeof item === 'string'))
          ) {
            filteredMetadata[key] = value;
          } else {
            // Optional: Log skipped keys for debugging
            // console.warn(`Skipping metadata key "${key}" for Pinecone upsert due to non-primitive value:`, value);
          }
        }
        // --- END FILTERING STEP ---


        return {
          id: this.generateVectorId(doc.pageContent), // Generate ID from content
          values: embeddings[i],
          metadata: {
            // Spread the *filtered* metadata
            ...filteredMetadata,

            // Explicitly add/override the 'text' field with pageContent
            // Ensure 'text' isn't accidentally filtered out if it was in originalMetadata
            text: doc.pageContent,

            // Re-add any specific fields you *know* should be there, if necessary
            // e.g., userId: filteredMetadata.userId || 'unknown', // Example
          },
        };
      });


      // 4. Create batches for upserting
      for (let i = 0; i < vectors.length; i += batchSize) {
        upsertBatches.push(vectors.slice(i, i + batchSize));
      }

      console.log(
        `Upserting ${vectors.length} vectors to index "${this.pineconeIndexName}" in ${upsertBatches.length} batches...`
      );

      // 5. Upsert batches to Pinecone
      for (let i = 0; i < upsertBatches.length; i++) {
        const batch = upsertBatches[i];
        await this.pineconeIndex.upsert(batch);
        console.log(`Upserted batch ${i + 1}/${upsertBatches.length} (${batch.length} vectors)`);
         // Optional small delay between batches if experiencing rate limits
         // await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`Successfully upserted ${vectors.length} vectors.`);
      return { success: true, vectorCount: vectors.length };

    } catch (error) {
      console.error("Error upserting documents to Pinecone:", error);
      // Log more details if available (e.g., Pinecone specific error)
      if (error.response) {
        console.error("Pinecone response error:", error.response.data);
      }
      return { success: false, error: error.message || error };
    }
  }

  /**
   * Checks if the configured Pinecone index exists.
   * @returns {Promise<boolean>} - True if the index exists, false otherwise.
   */
  async doesIndexExist() {
    try {
      console.log(`Checking if index "${this.pineconeIndexName}" exists...`);
      const indexListResponse = await this.pineconeClient.listIndexes();
      const exists = indexListResponse.indexes?.some((index) => index.name === this.pineconeIndexName) || false;
      console.log(`Index "${this.pineconeIndexName}" exists: ${exists}`);
      return exists;
    } catch (error) {
      console.error(`Error checking if index "${this.pineconeIndexName}" exists:`, error);
      return false; // Assume it doesn't exist on error
    }
  }

  /**
   * Creates the Pinecone index if it doesn't already exist.
   * Uses serverless specification by default.
   * @returns {Promise<boolean>} - True if the index was created or already exists and is ready, false on failure.
   */
  async createIndex() {
    try {
        // Check if index *already* exists before attempting creation
        if (await this.doesIndexExist()) {
             console.log(`Index "${this.pineconeIndexName}" already exists.`);
             // Optional: Check if it's ready, though waitForIndexCreation handles this too.
             await this.waitForIndexReady(this.pineconeIndexName); // Ensure it's ready
             return true;
        }

      console.log(`Creating Pinecone index "${this.pineconeIndexName}"...`);
      // Define the spec based on environment or defaults
      // Use serverless as default, adjust if using pod-based
      const spec = process.env.PINECONE_SPEC_TYPE === 'pod'
        ? {
            pod: {
              environment: process.env.PINECONE_ENVIRONMENT || "gcp-starter", // e.g., us-west1-gcp, aws-us-east-1
              podType: process.env.PINECONE_POD_TYPE || "p1.x1", // e.g., p1.x1, s1.x1
              // replicas: 1, // Optional: specify replicas
              // shards: 1, // Optional: specify shards
            }
          }
        : { // Default to serverless
            serverless: {
              cloud: process.env.PINECONE_CLOUD || "aws",
              region: process.env.PINECONE_ENVIRONMENT || "us-east-1",
            },
          };

      await this.pineconeClient.createIndex({
        name: this.pineconeIndexName,
        dimension: EMBEDDING_DIMENSION, // Use configured dimension
        metric: "cosine", // Or "euclidean", "dotproduct"
        spec: spec,
      });

      console.log(
        `Pinecone index "${this.pineconeIndexName}" creation initiated with spec:`, JSON.stringify(spec)
      );

      // Wait for the index to become ready
      await this.waitForIndexReady(this.pineconeIndexName);
      return true;

    } catch (error) {
      // Handle specific error like index already exists gracefully if check failed
      if (error.message && error.message.includes('already exists')) {
          console.warn(`Index "${this.pineconeIndexName}" already exists (caught during creation attempt).`);
          try {
              await this.waitForIndexReady(this.pineconeIndexName); // Still wait for readiness
              return true;
          } catch (waitError) {
               console.error(`Index "${this.pineconeIndexName}" exists but failed to become ready:`, waitError);
               return false;
          }
      }
      console.error(
        `Error creating or preparing Pinecone index "${this.pineconeIndexName}":`, error
      );
      return false;
    }
  }

  /**
   * Waits for the specified Pinecone index to be ready.
   * @param {string} indexName - The name of the index to check.
   * @param {number} [timeout=180000] - Maximum time to wait in milliseconds (default: 3 minutes).
   * @param {number} [interval=5000] - Interval between checks in milliseconds (default: 5 seconds).
   */
  async waitForIndexReady(indexName, timeout = 180000, interval = 5000) {
    console.log(`Waiting for index "${indexName}" to be ready...`);
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const indexDescription = await this.pineconeClient.describeIndex(
          indexName
        );
        if (indexDescription?.status?.ready) {
          console.log(`Pinecone index "${indexName}" is ready.`);
          return; // Index is ready, exit loop
        } else {
            console.log(`Index "${indexName}" status: ${indexDescription?.status?.state || 'unknown'}. Waiting...`);
        }
      } catch (error) {
        // Handle potential 404 if describeIndex is called too soon after createIndex
        if (error.response && error.response.status === 404) {
            console.warn(`Index "${indexName}" not found yet, possibly still provisioning... Retrying.`);
        } else {
            console.warn(
              `Error describing index "${indexName}", retrying...`,
              error.message
            );
        }
      }
      // Wait for the specified interval before checking again
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    // Timeout reached
    throw new Error(
      `Timeout waiting for Pinecone index "${indexName}" to become ready after ${timeout / 1000} seconds.`
    );
  }
}


module.exports = VectorStoreManager;