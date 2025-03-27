require("dotenv").config();
const { Worker, Queue } = require("bullmq");
const Client = require("../models/Client");
const VectorStoreManager = require("./PineconeService");
const { MarkdownTextSplitter } = require("langchain/text_splitter");
const TrainingList = require("../models/OpenaiTrainingList");
const OpenAIUsageController = require("../controllers/OpenAIUsageController");
const UnifiedPricingService = require("./UnifiedPricingService");
const ScrapeTracker = require("./scrapeTracker");
const appEvents = require("../events.js");

const redisConfig = {
  url: process.env.REDIS_URL,
  maxRetriesPerRequest: null,
};

const pineconeTrainQueue = new Queue("pineconeTraining", {
  connection: redisConfig,
});

// Send event to client (to be implemented based on your socket setup)
function sendClientEvent(userId, eventName, data) {
  appEvents.emit("userEvent", userId, eventName, {
    data,
  });
}

// Initialize once
const pricingService = new UnifiedPricingService();

// Check user credits before processing
async function checkUserCredits(userId, estimatedCost) {
  try {
    // This should be a method that checks if user has enough credits
    const hasEnoughCredits = await OpenAIUsageController.checkUserCredits(
      userId,
      estimatedCost
    );
    return hasEnoughCredits;
  } catch (error) {
    console.error(`Error checking credits for user ${userId}:`, error);
    return false;
  }
}

// // Record usage for the operation
async function recordUsage(userId, totalTokens, embeddingCost) {
  try {
    const result = await OpenAIUsageController.recordUsage(
      userId,
      "chat_completion",
      {
        totalTokens,
        embeddingCost,
        modelId: "gpt-3.5-turbo",
      }
    );

    if (!result.success) {
      throw new Error("Failed to record usage");
    }

    return true;
  } catch (error) {
    console.error(`Error recording usage for user ${userId}:`, error);
    throw new Error("Failed to record usage: " + error.message);
  }
}

const worker = new Worker(
  "pineconeTraining",
  async (job) => {
    const {
      type,
      pineconeIndexName,
      content,
      webPageURL,
      title,
      trainingListId,
      metaDescription,
    } = job.data;
    console.log(`Processing job for trainingListId: ${trainingListId}`);
    let userId = null;

    // Fetch the TrainingList object
    const trainingListObj = await TrainingList.findOne({ _id: trainingListId });

    if (!trainingListObj) {
      console.error(`TrainingList not found with id: ${trainingListId}`);
      throw new Error(); // Or throw an error to retry the job
    }
    userId = trainingListObj.userId;
    let pageUserId = userId;

    try {
      // Initialize ContentProcessor outside the loop
      const vectorStoreManager = new VectorStoreManager(pineconeIndexName);

      // Calculate costs
      const totalTokens = await pricingService.estimateTokens(content);
      const embeddingCost = await pricingService.calculateEmbeddingCost(
        totalTokens
      );
      // const storageCost = this.pricingService.calculatePineconeStorageCost(chunks.length);

      const hasCredits = await checkUserCredits(userId, embeddingCost);
      if (!hasCredits) {
        await TrainingList.findByIdAndUpdate(trainingListObj._id, {
          trainingStatus: 10,
          "webPage.mappingStatus": 3,
          lastEdit: Date.now(),
        });

        sendClientEvent(userId, "web-page-error-insufficient-credits", {
          trainingListId,
          error: "Insufficient credits to process this content",
        });

        // Return a specific error that can be caught by the queue system
        throw new Error("INSUFFICIENT_CREDITS");
      }

      // 3. Check if index exists, create if not
      if (!(await vectorStoreManager.doesIndexExist(pineconeIndexName))) {
        console.log(`Creating index "${pineconeIndexName}"...`);
        const created = await vectorStoreManager.createIndex(pineconeIndexName);
        if (!created) {
          sendClientEvent(userId, "web-page-error", {
            trainingListId,
            error: "Failed to create Pinecone Index",
          });
        }
      }
      // 4. Split content into chunks
      const textSplitter = new MarkdownTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      const chunks = await textSplitter.createDocuments([content], {
        url: webPageURL,
        title: title,
        type: type,
        userId: userId,
      });

      // 5. Record usage before performing the expensive operation
      await recordUsage(userId, totalTokens, embeddingCost);

      // 6. Upsert vectors into Pinecone

      if (chunks.length) {
        const upsertResult = await vectorStoreManager.upsertVectors(
          chunks.map((chunk) => chunk.pageContent),
          {
            url: webPageURL,
            title: title,
            type: type,
            userId: userId,
          }
        );

        if (!upsertResult.success) {
          throw new Error(
            "Failed to upsert vectors: " +
              (upsertResult.error || "Unknown error")
          );
        }
      }

      // 7. Update training list with successful status
      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.title": title,
        "webPage.metaDescription": metaDescription,
        "webPage.content": content,
        costDetails: {
          tokens: totalTokens,
          embedding: embeddingCost,
          totalCost: embeddingCost,
        },
        "webPage.mappingStatus": 2,
        trainingStatus: 4,
      });

      if (ScrapeTracker.getTracking(pageUserId)) {
        ScrapeTracker.updateTracking(pageUserId, "training", true);

        // Get updated tracking info
        const trackingInfo = ScrapeTracker.getTracking(pageUserId);

        // Check if all pages are processed
        const isComplete =
          trackingInfo.trainingCompleted + trackingInfo.failedPages >=
          trackingInfo.totalPages;

        // Emit progress update
        appEvents.emit("userEvent", userId, "scraping-progress", {
          status: isComplete ? "complete" : "in-progress",
          stage: "training",
          total: trackingInfo.totalPages,
          scrapingCompleted: trackingInfo.scrapingCompleted,
          minifyingCompleted: trackingInfo.minifyingCompleted,
          trainingCompleted: trackingInfo.trainingCompleted,
          failed: trackingInfo.failedPages,
        });

        // If complete, send completion event
        if (isComplete) {
          await Client.findByIdAndUpdate(
            { userId: userId },
            {
              webPageAdded: true,
            }
          );
          appEvents.emit("userEvent", userId, "scraping-complete", {
            total: trackingInfo.totalPages,
            processed: trackingInfo.trainingCompleted,
            failed: trackingInfo.failedPages,
            duration: Date.now() - trackingInfo.startTime,
          });

          // Clear tracking data after completion
          setTimeout(() => {
            ScrapeTracker.clearTracking(pageUserId);
          }, 60000); // Clear after 1 minute
        }
      }

      sendClientEvent(userId, "web-page-completed", {
        trainingListId,
        chunks: chunks.length,
      });

      return { success: true, chunks: chunks.length };
    } catch (error) {
      console.error("Error in pinecone training", error);
      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.mappingStatus": 3,
        trainingStatus: 9,
      });
      // If it's a credits issue, we might want to pause the queue or take specific action
      if (error.message === "INSUFFICIENT_CREDITS") {
        // You could implement queue pausing logic here
        console.log(
          `Pausing processing for user ${userId} due to insufficient credits`
        );
      }

      return { success: false, error };
    }
  },
  { connection: redisConfig, concurrency: 5, lockDuration: 30000 }
);
worker.on("completed", (job) => {
  console.log(`Job with id ${job.id} has completed`);
});

worker.on("failed", (job, err) => {
  console.log(`Job with id ${job.id} has failed with error ${err.message}`);

  // If the error is due to insufficient credits, you might want to
  // pause other jobs for the same user to prevent wasteful processing
  if (err.message === "INSUFFICIENT_CREDITS" && job.data) {
    const { trainingListId } = job.data;
    // Here you would implement logic to find and pause other jobs for this user
    console.log(
      `Pausing other jobs related to training list ${trainingListId} due to insufficient credits`
    );
  }
});

console.log("Worker started...");

module.exports = pineconeTrainQueue;
