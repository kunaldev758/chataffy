require("dotenv").config();
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const QdrantVectorStoreManager = require("./QdrantService");
// const crypto = require("crypto");

class BatchTrainingService {
  constructor() {
    // Increased chunk size for better semantic context
    // 500 tokens = ~2000 chars provides better context for embeddings
    this.CHUNK_SIZE = 500; // tokens (increased from 300)
    this.CHUNK_OVERLAP = 100; // tokens (increased from 50 for better continuity)
    this.CHARS_PER_TOKEN = 4; // Rough estimate
  }

  async deleteItemFromVectorStore(userId,url,type) {
    try{
      await vectorStore.deleteByFields({
        user_id: userId,
        url: url,
        type: type,
      });
    } catch(error){
      return error;
    }
  }

  // async processDocumentAndTrain(document, userId, qdrantIndexName) {
  //   try {
  //     const result = await this.processDocument(document, userId, qdrantIndexName);
  //     if(result.success){
  //       return {
  //         success: true,
  //         processedCount: result.success ? 1 : 0,
  //         failedCount: result.success ? 0 : 1,
  //         result
  //       };
  //     }else{
  //       return {
  //         success: false,
  //         processedCount: 0,
  //         failedCount: 1,
  //         result
  //       };
  //     }
  //   } catch (error) {
  //     console.error("Error processing document:", error);
  //     return {
  //       success: false,
  //       processedCount: 0,
  //       failedCount: 1,
  //       result,
  //     };
  //   }
  // }

  async processDocumentAndTrain(documents, userId, qdrantIndexName) {
    // const { content, metadata } = documents;

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






      // const docs = await textSplitter.createDocuments([content]);

      // const enhancedDocs = docs.map((doc, index) => ({
      //   ...doc,
      //   metadata: {
      //     ...metadata,
      //     user_id: userId,
      //     chunk_id: this.generateChunkId(content, index),
      //     chunk_index: index,
      //     total_chunks: docs.length,
      //     content_size: Buffer.byteLength(doc.pageContent, "utf8"),
      //     created_at: new Date().toISOString(),
      //   }
      // }));

      // const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
      // await vectorStore.createCollection();

      // const upsertResult = await vectorStore.upsertDocuments(enhancedDocs);

      // if (!upsertResult.success) {
      //   throw new Error(`Upsert failed: ${upsertResult.error}`);
      // }
      // return {
      //   success: true,
      //   chunkCount: enhancedDocs.length,
      // };

    } catch (error) {
      return{
        success:false,
        error:error.message
      }
    }
  }

  // generateChunkId(content, index) {
  //   const hash = crypto.createHash("sha256").update(content + index.toString()).digest("hex");
  //   return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
  // }
}

module.exports = BatchTrainingService;
