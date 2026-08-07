require("dotenv").config();
const QdrantVectorStoreManager = require("./QdrantService");
const { processPageDocuments } = require("./contentPipeline");

class BatchTrainingService {
  constructor() {
    this.CHUNK_SIZE = 500;
    this.CHUNK_OVERLAP = 100;
    this.CHARS_PER_TOKEN = 4;
  }

  async deleteItemFromVectorStore(userId, agentId, url, type, collectionName) {
    try {
      if (!collectionName) {
        return { success: false, error: "Missing collection name" };
      }
      const vectorStore = new QdrantVectorStoreManager(collectionName);
      return await vectorStore.deleteByFields({
        user_id: userId?.toString(),
        agent_id: agentId?.toString(),
        url,
        ...(type !== undefined && type !== null ? { type } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Chunk + embed + upsert scraped docs.
   * Phase 1: per-URL delete-then-upsert via contentPipeline (no stale chunk accumulation).
   */
  async processDocumentAndTrain(
    documents,
    userId,
    agentId,
    qdrantIndexName,
    options = {},
  ) {
    // Some callers still pass a boolean as the 5th arg; coerce to options object.
    const opts =
      options && typeof options === "object" && !Array.isArray(options)
        ? options
        : {};
    const { onProgress, TrainingModel = null } = opts;
    try {
      if (!documents || documents.length === 0) {
        return {
          success: true,
          totalChunks: 0,
          chunkCountPerUrl: {},
          failedUrls: [],
          resultsByUrl: {},
        };
      }

      const result = await processPageDocuments(
        documents,
        userId,
        agentId,
        qdrantIndexName,
        {
          onProgress,
          TrainingModel,
          chunkSize: this.CHUNK_SIZE,
          chunkOverlap: this.CHUNK_OVERLAP,
        },
      );

      console.log("Upsert result response", {
        success: result.success,
        totalChunks: result.totalChunks,
        failedUrls: result.failedUrls,
      });

      const firstFailedUrl = (result.failedUrls || [])[0];
      const firstFailedError =
        firstFailedUrl && result.resultsByUrl?.[firstFailedUrl]?.error
          ? result.resultsByUrl[firstFailedUrl].error
          : undefined;

      return {
        success: result.success,
        totalChunks: result.totalChunks,
        chunkCountPerUrl: result.chunkCountPerUrl,
        failedUrls: result.failedUrls || [],
        skippedUrls: result.skippedUrls || [],
        storageMB: result.storageMB,
        estimatedCost: result.estimatedCost,
        resultsByUrl: result.resultsByUrl || {},
        error: firstFailedError,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = BatchTrainingService;
