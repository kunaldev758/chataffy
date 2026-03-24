require("dotenv").config();
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const QdrantVectorStoreManager = require("./QdrantService");

class BatchTrainingService {
  constructor() {
    // Increased chunk size for better semantic context
    // 500 tokens = ~2000 chars provides better context for embeddings
    this.CHUNK_SIZE = 500; // tokens (increased from 300)
    this.CHUNK_OVERLAP = 100; // tokens (increased from 50 for better continuity)
    this.CHARS_PER_TOKEN = 4; // Rough estimate
  }

  async deleteItemFromVectorStore(userId,agentId,url,type) {
    try{
      await vectorStore.deleteByFields({
        user_id: userId,
        agent_id: agentId,
        url: url,
        type: type,
      });
    } catch(error){
      return error;
    }
  }


  async processDocumentAndTrain(documents, userId, agentId, qdrantIndexName) {
    try {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: this.CHUNK_SIZE * this.CHARS_PER_TOKEN,
        chunkOverlap: this.CHUNK_OVERLAP * this.CHARS_PER_TOKEN,
        separators: ["\n\n", "\n", ". ", " ", ""]
      });

      let allChunks = [];
      let chunkCountPerUrl = {};

      for (const doc of documents) {
        const chunks = await splitter.createDocuments([doc.content]);
        chunkCountPerUrl[doc?.originalUrl] = chunks.length;

        const enhancedChunks = chunks.map((chunk, index) => ({
          ...chunk,
          metadata: {
            ...doc.metadata,
            user_id: userId?.toString(), // Ensure user_id is always a string for Qdrant filtering
            agent_id: agentId?.toString(),
            chunk_index: index,
            total_chunks: chunks.length,
            created_at: new Date().toISOString(),
          },
        }));

        allChunks.push(...enhancedChunks);
      }

      const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
      await vectorStore.createCollection();

      const upsertResult = await vectorStore.upsertDocuments(allChunks, userId);
      console.log("Upsert result response",upsertResult);
      return {
        success: upsertResult?.success,
        totalChunks: allChunks?.length,
        chunkCountPerUrl,
        failedUrls: upsertResult?.failedUrls || [],
        storageMB: upsertResult?.storageMB,
        estimatedCost: upsertResult?.estimatedCost
      };
    } catch (error) {
      return{
        success:false,
        error:error.message
      }
    }
  }
}

module.exports = BatchTrainingService;
