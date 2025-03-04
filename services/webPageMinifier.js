// services/webPageMinifier.js
const { emitSocketEvent } = require("../helpers/socketHelper");
const ContentProcessor = require("./contentProcessor");
const TrainingList = require("../models/OpenaiTrainingList");

async function minifyWebPage(trainingListObj, io, pineconeIndexName) {
  const userId = trainingListObj.userId;
  const trainingListId = trainingListObj._id;

  try {
    emitSocketEvent(io, userId, "webPageMinifyingStarted", { trainingListId });

    const contentProcessor = new ContentProcessor(pineconeIndexName);
    const vectorStoreManager = contentProcessor.vectorStoreManager;

    if (!(await vectorStoreManager.doesIndexExist(pineconeIndexName))) {
      console.log(`Index "${pineconeIndexName}" does not exist. Creating...`);
      const created = await vectorStoreManager.createIndex(pineconeIndexName);

      if (!created) {
        console.error("Failed to create Pinecone index!");
        emitSocketEvent(io, userId, "trainingFailed", {
          error: "Failed to create Pinecone index. Training aborted.",
        });
        return {
          success: false,
          error: "Failed to create Pinecone index. Training aborted.",
        };
      }
      console.log(`Index "${pineconeIndexName}" created successfully.`);
    } else {
      console.log(`Index "${pineconeIndexName}" already exists.`);
    }

    const processResult = await contentProcessor.processWebPage(trainingListObj);

    if (!processResult.success) {
      console.error(
        `Error processing ${trainingListObj.webPage.url}:`,
        processResult.error
      );
      await TrainingList.findByIdAndUpdate(trainingListId, {
        lastEdit: Date.now(),
        "trainingProcessStatus.minifyingStatus": 3,
        trainingStatus: 9,
      });
      emitSocketEvent(io, userId, "webPageMinifyingFailed", {
        trainingListId,
        error: processResult.error,
      });
      return { success: false, error: processResult.error };
    }

    await TrainingList.findByIdAndUpdate(trainingListObj._id, {
      "webPage.title": processResult.title,
      "webPage.metaDescription": processResult.metaDescription,
      "webPage.content": processResult.content,
      costDetails: {
        tokens: processResult.totalTokens,
        embedding: processResult.embeddingCost,
        storage: processResult.storageCost,
        totalCost: processResult.embeddingCost + processResult.storageCost,
      },
      "trainingProcessStatus.minifyingStatus": 2,
      "trainingProcessStatus.minifyingDuration.end": Date.now(),
      trainingStatus: 4,
    });
    emitSocketEvent(io, userId, "webPageMinified", { trainingListId });
    return { success: true, chunks: processResult.chunks };
  } catch (error) {
    console.error(`Error minifying ${trainingListObj.webPage.url}:`, error);
    await TrainingList.findByIdAndUpdate(trainingListId, {
      lastEdit: Date.now(),
      "trainingProcessStatus.minifyingStatus": 3,
      trainingStatus: 9,
    });
    emitSocketEvent(io, userId, "webPageMinifyingFailed", {
      trainingListId,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

module.exports = { minifyWebPage };