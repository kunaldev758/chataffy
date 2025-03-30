const pineconeTrainQueue = require("./TrainData");

async function processFileOrSnippet(data) {
  try {
    let content, metadata;
    if (data.type == "faq") {
    } else {
      if (data.file) {
        content = await this.readFileContent(
          data.file.path,
          data.file.mimetype
        );
        metadata = {
          title: data.file.originalname,
          type: "file",
          mimeType: data.file.mimetype,
          userId: data.userId,
        };
      } else {
        content = data.content;
        metadata = {
          title: data.title,
          type: "snippet",
          userId: data.userId,
        };
      }

      // TrainData.pineconeTraining(
      //   metadata.type,
      //   metadata.title,
      //   content,
      //   metadata.userId,
      //   metadata
      // );
      await pineconeTrainQueue.add("pineconeTraining", {
        type: data.type,
        pineconeIndexName,
        content,
        // webPageURL,
        title,
        trainingListId,
        // metaDescription,
      }); // Job Name and data

      // return {
      //   success: true,
      //   costs: {
      //     tokens: totalTokens,
      //     embedding: embeddingCost,
      //     storage: storageCost,
      //     total: embeddingCost + storageCost,
      //   },
      //   chunks: chunks.length,
      // };
    }
  } catch (error) {
    console.error("Error processing file/snippet:", error);
    return { success: false, error };
  }
}
