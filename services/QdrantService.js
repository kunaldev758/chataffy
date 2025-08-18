require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
// const UsageTrackingService = require("./UsageTrackingService")
const {logOpenAIUsage , logQdrantUsage} = require('../services/UsageTrackingService');
const { v4: uuidv4 } = require("uuid");

const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIMENSION = parseInt(
  process.env.OPENAI_EMBEDDING_DIMENSION || "1536",
  10
);

class QdrantVectorStoreManager {
  constructor(collectionName) {
    if (!collectionName) {
      throw new Error("Qdrant collection name must be provided.");
    }
    this.collectionName = collectionName;

    this.qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });

    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: EMBEDDING_MODEL,
    });

    console.log(
      `QdrantVectorStoreManager initialized for collection "${this.collectionName}" using embedding model "${EMBEDDING_MODEL}"`
    );
  }

  // generateVectorId(textContent, index = 0) {
  //   // Generate a unique UUID for each document chunk
  //   // This ensures compatibility with Qdrant's ID requirements
  //   return uuidv4();
  // }

  async upsertDocuments(documents,userId) {
    if (!documents || documents.length === 0) {
      console.log("No documents provided to upsert.");
      return { success: true, vectorCount: 0 };
    }

    try {
      const contents = documents.map((doc) => doc.pageContent);
      // console.log(`Generating embeddings for ${contents.length} documents...`);

      // Batch embedding requests for efficiency
      const batchSize = 100; // OpenAI embedding batch limit
      const embeddings = [];
      // Removed redeclaration of totalUpserted to fix lint error

      for (let i = 0; i < contents.length; i += batchSize) {
        const batch = contents.slice(i, i + batchSize);
        // console.log(`Processing embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(contents.length / batchSize)}`);
        const batchEmbeddings = await this.embeddings.embedDocuments(batch);
        // const tokens = batchEmbeddings.reduce((sum, embedding) => sum + embedding.tokens, 0);
        const tokens = batch.reduce((sum, text) => {
          if (typeof text === 'string' && text.length > 0) {
            return sum + Math.ceil(text.length / 4);
          }
          return sum;
        }, 0);
        if (tokens > 0) {
          logOpenAIUsage({userId, tokens, requests:1});
        }
        
        embeddings.push(...batchEmbeddings);
      }

      console.log(`Generated ${embeddings.length} embeddings, creating points...`);


      const points = documents.map((doc, i) => ({
        id: uuidv4(),
        vector: embeddings[i],
        payload: {
          ...doc.metadata,
          text: doc.pageContent,
          created_at: new Date().toISOString(),
        },
      }));


      // const points = documents.map((doc, i) => {
      //   id : uuidv4(), //this.generateVectorId(doc.pageContent, i);
      //   vector: embeddings[i],
      //   payload: {
      //     ...doc.metadata,
      //     text: doc.pageContent,
      //     created_at: new Date().toISOString(),
      //   },
      // // }));

      //   // Filter metadata to ensure Qdrant compatibility
      //   const originalMetadata = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
      //   const filteredMetadata = {};

      //   for (const key in originalMetadata) {
      //     const value = originalMetadata[key];
      //     if (
      //       typeof value === "string" ||
      //       typeof value === "number" ||
      //       typeof value === "boolean" ||
      //       value === null ||
      //       typeof value === "undefined" ||
      //       (Array.isArray(value) &&value.every((item) => typeof item === "string"))
      //     ) {
      //       // Ensure string values aren't too long for Qdrant
      //       if (typeof value === "string" && value.length > 1000) {
      //         filteredMetadata[key] = value.substring(0, 1000) + "...";
      //       } else {
      //         filteredMetadata[key] = value;
      //       }
      //     }
      //   }

      //   return {
      //     id,
      //     vector: embeddings[i],
      //     payload: {
      //       ...filteredMetadata,
      //       text: doc.pageContent,
      //       created_at: new Date().toISOString(),
      //       content_length: doc.pageContent.length,
      //     },
      //   };
      // });

      // console.log(`Created ${points.length} points, starting upsert...`);

      // Batch upsert for better performance
      const upsertBatchSize = 256; // Reduced batch size for stability
      // let totalUpserted = 0;

      for (let i = 0; i < points.length; i += upsertBatchSize) {
        const batch = points.slice(i, i + upsertBatchSize);
        // const batchNumber = Math.floor(i / upsertBatchSize) + 1;
        // const totalBatches = Math.ceil(points.length / upsertBatchSize);

        // try {
          // console.log(`Upserting batch ${batchNumber}/${totalBatches} (${batch.length} points)...`);

          await this.qdrantClient.upsert(this.collectionName, {points: batch,wait: true,});

          // totalUpserted += batch.length;
          // console.log(
          //   `Successfully upserted batch ${batchNumber}/${totalBatches}`
          // );
        // } catch (batchError) {
        //   console.error(`Error upserting batch ${batchNumber}:`, batchError);

        //   // Log problematic point details for debugging
        //   console.error("Batch details:");
        //   batch.forEach((point, idx) => {
        //     console.error(
        //       `  Point ${idx + 1}: ID=${point.id}, VectorLen=${
        //         point.vector.length
        //       }, PayloadKeys=[${Object.keys(point.payload).join(", ")}]`
        //     );
        //   });

        //   throw new Error(
        //     `Batch upsert failed at batch ${batchNumber}: ${batchError.message}`
        //   );
        // }
      }

        // Calculate storage usage
        const totalVectors = points.length;
        const vectorSizeBytes = totalVectors * EMBEDDING_DIMENSION * 4;
        const storageMB = vectorSizeBytes / (1024 * 1024);
        const estimatedCost = {
          storage: (storageMB / 1024) * 0.12, // $0.12 per GB/month
          requests: (Math.ceil(points.length / upsertBatchSize) * 0.10) / 1000,
        };
  
        await logQdrantUsage({
          userId,
          vectorsAdded: totalVectors,
          vectorsDeleted:0,
          storageMB,
          collectionName: this.collectionName,
          estimatedCost
        });

        console.log("upsert Successful")
  
        return { success: true, vectorCount: totalVectors, storageMB, estimatedCost,failedUrls:[] };

      // const storageMB = 0; // Replace with actual storage used if you can fetch it
      // const cost = (totalUpserted / 1000) * 0.10 + (apiCalls / 1000) * 0.05 + (storageMB * 0.02);

      // await UsageTrackingService.logQdrantUsage({
      //   // userId:this.collectionName.toString(),
      //   vectorsAdded: totalUpserted,
      //   vectorsDeleted: 0,
      //   // apiCalls,
      //   // storageMB,
      //   collectionName: this.collectionName,
      //   // cost,
      // });

      // console.log(`Successfully upserted ${totalUpserted} vectors total.`);
      // return { success: true, vectorCount: totalUpserted };
    } catch (error) {
      console.error("Error upserting documents to Qdrant:", error);
      return { success: false, error: error.message,failedUrls: [] };
    }
  }

  async doesCollectionExist() {
    try {
      const collections = await this.qdrantClient.getCollections();
      const exists = collections.collections.some(
        (col) => col.name === this.collectionName
      );
      console.log(`Collection "${this.collectionName}" exists: ${exists}`);
      return exists;
    } catch (error) {
      console.error(`Error checking collection existence: ${error}`);
      return false;
    }
  }

  async createCollection() {
    try {
      const exists = await this.doesCollectionExist();
      if (exists) {
        console.log(`Collection "${this.collectionName}" already exists.`);
        return true;
      }

      console.log(`Creating Qdrant collection "${this.collectionName}"...`);
      await this.qdrantClient.createCollection(this.collectionName, {
        vectors: {
          size: EMBEDDING_DIMENSION,
          distance: "Cosine",
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });

      console.log(`Collection "${this.collectionName}" created successfully.`);
      return true;
    } catch (error) {
      console.error(`Error creating collection: ${error}`);
      return false;
    }
  }

  async search(queryEmbedding, k = 5) {
    try {
      const results = await this.qdrantClient.search(this.collectionName, {
        vector: queryEmbedding,
        limit: k,
        with_payload: true,
      });

      return results;
    } catch (error) {
      console.error(`Error searching Qdrant collection: ${error}`);
      return [];
    }
  }

  async deleteCollection() {
    try {
      console.log(`Deleting collection "${this.collectionName}"...`);
      await this.qdrantClient.deleteCollection(this.collectionName);
      console.log(`Collection "${this.collectionName}" deleted successfully.`);
      return true;
    } catch (error) {
      console.error(`Error deleting collection: ${error}`);
      return false;
    }
  }

  async migrateCollection(sourceCollection, targetCollection, batchSize = 100) {
    try {
      // 1. Get total number of points in the source collection
      const sourceInfo = await this.qdrantClient.getCollection(sourceCollection);
      const totalPoints = sourceInfo.points_count || 0;
      
      if (totalPoints === 0) {
        return { success: true, migrated: 0, message: "No points to migrate." };
      }
  
      console.log(`Starting migration of ${totalPoints} points from ${sourceCollection} to ${targetCollection}`);
  
      // 2. Create target collection if it doesn't exist
      const targetManager = new QdrantVectorStoreManager(targetCollection);
      await targetManager.ensureCollection(); // Use ensureCollection instead of createCollection
  
      let migrated = 0;
      let nextPageOffset = null; // This will hold the offset for pagination
  
      while (true) {
        try {
          // 3. Use scroll with proper pagination
          const scrollParams = {
            limit: batchSize,
            with_vector: true,
            with_payload: true,
          };
  
          // Add offset only if we have one from previous iteration
          if (nextPageOffset !== null) {
            scrollParams.offset = nextPageOffset;
          }
  
          console.log(`Fetching batch with params:`, scrollParams);
          
          const scrollResult = await this.qdrantClient.scroll(sourceCollection, scrollParams);
          
          const points = scrollResult.points || [];
          
          if (points.length === 0) {
            console.log("No more points found, migration complete");
            break;
          }
  
          console.log(`Retrieved ${points.length} points in this batch`);
  
          // 4. Transform points for upsert (ensure proper format)
          const transformedPoints = points.map((pt) => ({
            id: pt.id,
            vector: Array.isArray(pt.vector) ? pt.vector : pt.vector.vector || pt.vector, // Handle different vector formats
            payload: pt.payload || {},
          }));
  
          // 5. Upsert points into the target collection
          await targetManager.qdrantClient.upsert(targetCollection, {
            points: transformedPoints,
            wait: true, // Wait for this batch to be indexed
          });
  
          migrated += points.length;
          console.log(`Migrated ${migrated}/${totalPoints} points (${((migrated/totalPoints)*100).toFixed(1)}%)`);
  
          // 6. Update offset for next iteration
          // Get the last point's ID or use the next_page_offset if provided
          if (scrollResult.next_page_offset) {
            nextPageOffset = scrollResult.next_page_offset;
          } else if (points.length < batchSize) {
            // If we got fewer points than requested, we're at the end
            console.log("Reached end of collection (partial batch)");
            break;
          } else {
            // Use the last point's ID as offset for next batch
            nextPageOffset = points[points.length - 1].id;
          }
  
          // Add a small delay to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 100));
  
        } catch (batchError) {
          console.error(`Error in batch migration at offset ${nextPageOffset}:`, batchError);
          
          // Try to continue with next batch if it's not a critical error
          if (batchError.message && batchError.message.includes('not found')) {
            console.log("Continuing to next batch...");
            if (nextPageOffset) {
              // Try to increment the offset manually
              nextPageOffset = typeof nextPageOffset === 'string' ? 
                parseInt(nextPageOffset) + batchSize : nextPageOffset + batchSize;
            }
            continue;
          } else {
            throw batchError; // Re-throw critical errors
          }
        }
      }
  
      // 7. Verify migration
      const targetInfo = await targetManager.qdrantClient.getCollection(targetCollection);
      const actualMigrated = targetInfo.points_count || 0;
  
      console.log(`Migration completed. Expected: ${migrated}, Actual in target: ${actualMigrated}`);
  
      return { 
        success: true, 
        migrated, 
        actualPointsInTarget: actualMigrated,
        message: `Successfully migrated ${migrated} points. Target collection now has ${actualMigrated} points.`
      };
  
    } catch (error) {
      console.error("Error migrating collection:", error);
      return { 
        success: false, 
        migrated: 0, 
        error: error.message || error 
      };
    }
  }

  /**
   * Delete points from the collection matching the given filter fields.
   * @param {Object} filterFields - Key-value pairs to match (e.g., { url, user_id, type }).
   * @returns {Promise<{success: boolean, deleted?: number, error?: string}>}
   */
  async deleteByFields(filterFields) {
    try {
      if (
        !filterFields ||
        typeof filterFields !== "object" ||
        Object.keys(filterFields).length === 0
      ) {
        throw new Error("No filter fields provided for deletion.");
      }

      // Build Qdrant filter
      const must = Object.entries(filterFields).map(([key, value]) => ({
        key,
        match: { value },
      }));

      const filter = { must };

      // Perform the delete operation
      const result = await this.qdrantClient.delete(this.collectionName, {
        filter,
        wait: true,
      });

      // Qdrant returns the number of deleted points in the result (if available)
      return {
        success: true,
        deleted: result?.result?.operation_id
          ? undefined
          : result?.result?.status,
      };
    } catch (error) {
      console.error("Error deleting points by fields:", error);
      return { success: false, error: error.message || error };
    }
  }
}

module.exports = QdrantVectorStoreManager;
