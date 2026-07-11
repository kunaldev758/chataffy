require("dotenv").config();
const QdrantVectorStoreManager = require("./QdrantService");
const { chunkContentByStructure } = require("../utils/structureChunker");

class BatchTrainingService {
  constructor() {
    // Keep constructor for backward compatibility
  }

  async deleteItemFromVectorStore(userId, agentId, url, type) {
    try {
      const qdrantIndexName = `${userId}-${agentId}`; // standard fallback structure
      const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
      await vectorStore.deleteByFields({
        user_id: userId?.toString(),
        agent_id: agentId?.toString(),
        url: url,
        type: type,
      });
    } catch (error) {
      return error;
    }
  }

  async processDocumentAndTrain(documents, userId, agentId, qdrantIndexName, options = {}) {
    const { onProgress } = options;
    try {
      let allChunks = [];
      let chunkCountPerUrl = {};
      const docTotal = documents.length;
      
      const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
      await vectorStore.createCollection();

      for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        const doc = documents[docIndex];
        
        // Delete old vectors in Qdrant for this specific item before re-indexing to avoid orphaned chunks
        try {
          if (doc.type === 0 && doc.originalUrl) {
            // Delete webpage vectors by URL
            await vectorStore.deleteByFields({
              user_id: userId?.toString(),
              agent_id: agentId?.toString(),
              url: doc.originalUrl,
            });
          } else if (doc.metadata?.title) {
            // Delete file/snippet/FAQ vectors by title
            await vectorStore.deleteByFields({
              user_id: userId?.toString(),
              agent_id: agentId?.toString(),
              title: doc.metadata.title,
            });
          }
        } catch (deleteError) {
          console.warn(`[BatchTrainingService] Error clearing old vectors for ${doc.originalUrl || doc.metadata?.title}: ${deleteError.message}`);
        }

        // Structure-aware chunking based on entity_type
        const entityType = doc.metadata?.entity_type || (doc.type === 3 ? "faq" : "general");
        const attributes = doc.metadata?.attributes || {};
        const entityName = doc.metadata?.entity_name || doc.metadata?.title || "";
        const url = doc.metadata?.url || doc.originalUrl || "";

        const chunks = chunkContentByStructure(doc.content, entityType, attributes, entityName, url);
        chunkCountPerUrl[doc?.originalUrl || doc.metadata?.title] = chunks.length;

        const enhancedChunks = chunks.map((chunk, index) => ({
          pageContent: chunk.text,
          metadata: {
            ...doc.metadata,
            user_id: userId?.toString(), // Ensure user_id is always a string for Qdrant filtering
            agent_id: agentId?.toString(),
            chunk_index: index,
            total_chunks: chunks.length,
            heading_path: chunk.heading_path || "",
            created_at: doc.metadata?.created_at || new Date().toISOString(),
          },
        }));

        allChunks.push(...enhancedChunks);

        if (onProgress) {
          await onProgress({
            phase: "training",
            trainingProcessed: docIndex + 1,
            trainingTotal: docTotal,
            step: "chunking",
          });
        }
      }

      if (allChunks.length === 0) {
        console.log("No chunks generated for indexing.");
        return {
          success: true,
          totalChunks: 0,
          chunkCountPerUrl,
          failedUrls: [],
        };
      }

      const upsertResult = await vectorStore.upsertDocuments(allChunks, userId, {
        agentId,
        onProgress: onProgress
          ? async (event) => {
              if (event.step === "embedding") {
                await onProgress({
                  phase: "training",
                  trainingProcessed: docTotal,
                  trainingTotal: docTotal,
                  embeddingProgress: event.embedded,
                  embeddingTotal: event.total,
                  step: "embedding",
                });
              } else if (event.step === "upserting") {
                await onProgress({
                  phase: "training",
                  trainingProcessed: docTotal,
                  trainingTotal: docTotal,
                  embeddingProgress: event.total,
                  embeddingTotal: event.total,
                  upsertProgress: event.upserted,
                  upsertTotal: event.total,
                  step: "upserting",
                });
              }
            }
          : undefined,
      });

      console.log("Upsert result response", upsertResult);
      return {
        success: upsertResult?.success,
        totalChunks: allChunks?.length,
        chunkCountPerUrl,
        failedUrls: upsertResult?.failedUrls || [],
        storageMB: upsertResult?.storageMB,
        estimatedCost: upsertResult?.estimatedCost
      };
    } catch (error) {
      console.error("[BatchTrainingService] training error:", error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = BatchTrainingService;
