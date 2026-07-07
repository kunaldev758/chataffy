require("dotenv").config();
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const QdrantVectorStoreManager = require("./QdrantService");
const { buildDocuments } = require("./documentBuilderService");
const { DOC_TYPE } = require("../constants/contentTypes");

class BatchTrainingService {
  constructor() {
    this.CHUNK_SIZE = 500;
    this.CHUNK_OVERLAP = 100;
    this.CHARS_PER_TOKEN = 4;
  }

  async deleteItemFromVectorStore(userId, agentId, url, type) {
    try {
      const vectorStore = new QdrantVectorStoreManager(type);
      await vectorStore.deleteByFields({
        user_id: userId,
        agent_id: agentId,
        url: url,
        type: type,
      });
    } catch (error) {
      return error;
    }
  }

  async processDocumentAndTrain(
    documents,
    userId,
    agentId,
    qdrantIndexName,
    options = {},
  ) {
    const { onProgress } = options;
    try {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: this.CHUNK_SIZE * this.CHARS_PER_TOKEN,
        chunkOverlap: this.CHUNK_OVERLAP * this.CHARS_PER_TOKEN,
        separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
      });

      let allChunks = [];
      let chunkCountPerUrl = {};
      const docTotal = documents.length;

      for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        const doc = documents[docIndex];
        const sourceUrl = doc?.originalUrl || doc?.metadata?.url || "";
        const builtDocs = buildDocuments(doc);

        if (!chunkCountPerUrl[sourceUrl]) {
          chunkCountPerUrl[sourceUrl] = 0;
        }

        for (const builtDoc of builtDocs) {
          const docType = builtDoc.metadata?.doc_type || DOC_TYPE.KNOWLEDGE;

          if (docType === DOC_TYPE.ENTITY) {
            allChunks.push({
              pageContent: builtDoc.pageContent,
              metadata: {
                ...builtDoc.metadata,
                user_id: userId?.toString(),
                agent_id: agentId?.toString(),
                chunk_index: builtDoc.metadata?.entity_index ?? 0,
                total_chunks: builtDoc.metadata?.entity_count ?? 1,
                created_at: new Date().toISOString(),
              },
            });
            chunkCountPerUrl[sourceUrl] += 1;
            continue;
          }

          const chunks = await splitter.createDocuments([builtDoc.pageContent]);
          chunkCountPerUrl[sourceUrl] += chunks.length;

          const enhancedChunks = chunks.map((chunk, index) => ({
            ...chunk,
            metadata: {
              ...doc.metadata,
              ...builtDoc.metadata,
              user_id: userId?.toString(),
              agent_id: agentId?.toString(),
              chunk_index: index,
              total_chunks: chunks.length,
              created_at: new Date().toISOString(),
            },
          }));

          allChunks.push(...enhancedChunks);
        }

        if (onProgress) {
          await onProgress({
            phase: "training",
            trainingProcessed: docIndex + 1,
            trainingTotal: docTotal,
            step: "chunking",
          });
        }
      }

      const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
      await vectorStore.createCollection();

      const upsertResult = await vectorStore.upsertDocuments(allChunks, userId, {
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
        estimatedCost: upsertResult?.estimatedCost,
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
