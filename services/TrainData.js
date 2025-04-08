require("dotenv").config();
const { Worker, Queue } = require("bullmq");
const Client = require("../models/Client");
const VectorStoreManager = require("./PineconeService");
const { MarkdownTextSplitter } = require("langchain/text_splitter");
const TrainingList = require("../models/OpenaiTrainingList");
const OpenAIUsageController = require("../controllers/OpenAIUsageController");
const UnifiedPricingService = require("./UnifiedPricingService");
const ScrapeTracker = require("./ScrapeTracker");
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

// Record usage for the operation
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

// Helper function to get content type name
function getContentTypeName(typeCode) {
  const types = ["webpage", "file", "snippet", "faq"];
  return types[typeCode] || "unknown";
}

const worker = new Worker(
  "pineconeTraining",
  async (job) => {
    const {
      type,  // 0-WebPage, 1-File, 2-Snippet, 3-Faq
      pineconeIndexName,
      trainingListId,
      // Other props might be included depending on type
    } = job.data;
    
    console.log(`Processing job for trainingListId: ${trainingListId}, type: ${type}`);
    let userId = null;

    // Fetch the TrainingList object
    const trainingListObj = await TrainingList.findOne({ _id: trainingListId });

    if (!trainingListObj) {
      console.error(`TrainingList not found with id: ${trainingListId}`);
      throw new Error("Training list not found");
    }
    
    userId = trainingListObj.userId;
    let contentToProcess = "";
    let metadata = {};
    const contentType = parseInt(type);
    
    try {
      // Extract content and metadata based on content type
      switch (contentType) {
        case 0: // WebPage
          contentToProcess = job.data.content
          metadata = {
            url: job.data.webPageURL ,
            title: job.data.title ,
            type: "webpage",
            userId: userId,
            metaDescription: job.data.metaDescription 
          };
          break;
          
        case 1: // File
          contentToProcess = job.data.content;
          metadata = {
            fileName: job.data.fileName,
            originalFileName: job.data.originalFileName,
            title: job.data.title,
            type: "file",
            userId: userId
          };
          break;
          
        case 2: // Snippet
          contentToProcess = job.data.content;
          metadata = {
            title: job.data.title,
            type: "snippet",
            userId: userId
          };
          break;
          
        case 3: // FAQ
          // For FAQ, we combine question and answer with proper formatting
          contentToProcess =job.data.content;
          metadata = {
            question: job.data.title,
            type: "faq",
            userId: userId
          };
          break;
          
        default:
          throw new Error(`Unsupported content type: ${contentType}`);
      }
      
      if (!contentToProcess) {
        throw new Error("No content found to process");
      }

      // Initialize VectorStoreManager
      const vectorStoreManager = new VectorStoreManager(pineconeIndexName);

      // Calculate costs
      const totalTokens = await pricingService.estimateTokens(contentToProcess);
      const embeddingCost = await pricingService.calculateEmbeddingCost(totalTokens);

      // Check if user has enough credits
      const hasCredits = await checkUserCredits(userId, embeddingCost);
      if (!hasCredits) {
        // Update status based on content type
        const updateObj = { trainingStatus: 10, lastEdit: Date.now() };
        
        // Add type-specific status update
        if (contentType === 0) updateObj["webPage.mappingStatus"] = 3;
        
        await TrainingList.findByIdAndUpdate(trainingListObj._id, updateObj);

        sendClientEvent(userId, "content-error-insufficient-credits", {
          trainingListId,
          contentType,
          typeName: getContentTypeName(contentType),
          error: "Insufficient credits to process this content",
        });

        throw new Error("INSUFFICIENT_CREDITS");
      }

      // Check if index exists, create if not
      if (!(await vectorStoreManager.doesIndexExist(pineconeIndexName))) {
        console.log(`Creating index "${pineconeIndexName}"...`);
        const created = await vectorStoreManager.createIndex(pineconeIndexName);
        if (!created) {
          sendClientEvent(userId, "content-error", {
            trainingListId,
            contentType,
            typeName: getContentTypeName(contentType),
            error: "Failed to create Pinecone Index",
          });
          throw new Error("Failed to create Pinecone index");
        }
      }
      
      // Configure text splitter based on content type
      let chunkSize = 1000;
      let chunkOverlap = 200;
      
      // Adjust chunk size for different content types
      if (contentType === 3) { // FAQ
        chunkSize = 2000; // Larger chunks for FAQs to keep Q&A together
      } else if (contentType === 2) { // Snippet
        chunkSize = 1500; // Medium size for snippets
        chunkOverlap = 150;
      }
      
      const textSplitter = new MarkdownTextSplitter({
        chunkSize,
        chunkOverlap,
      });

      const chunks = await textSplitter.createDocuments([contentToProcess], metadata);

      // Record usage before performing the expensive operation
      await recordUsage(userId, totalTokens, embeddingCost);

      // Upsert vectors into Pinecone
      if (chunks.length) {
        const upsertResult = await vectorStoreManager.upsertVectors(
          chunks.map((chunk) => chunk.pageContent),
          metadata
        );

        if (!upsertResult.success) {
          throw new Error(
            "Failed to upsert vectors: " + (upsertResult.error || "Unknown error")
          );
        }
      }

      // Update training list with successful status
      const updateObj = {
        costDetails: {
          tokens: totalTokens,
          embedding: embeddingCost,
          totalCost: embeddingCost,
        },
        trainingStatus: 4, // Mapped
        lastEdit: Date.now()
      };
      
      // Add type-specific status update for web pages
      if (contentType === 0) {
        updateObj["webPage.mappingStatus"] = 2; // Success
      }
      
      await TrainingList.findByIdAndUpdate(trainingListObj._id, updateObj);

      // Handle special tracking for web pages
      if (contentType === 0 && ScrapeTracker.getTracking(userId)) {
        ScrapeTracker.updateTracking(userId, "training", true);

        // Get updated tracking info
        const trackingInfo = ScrapeTracker.getTracking(userId);

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
          await Client.updateOne({ userId: userId }, { webPageAdded: true });
          appEvents.emit("userEvent", userId, "scraping-complete", {
            total: trackingInfo.totalPages,
            processed: trackingInfo.trainingCompleted,
            failed: trackingInfo.failedPages,
            duration: Date.now() - trackingInfo.startTime,
          });

          // Clear tracking data after completion
          setTimeout(() => {
            ScrapeTracker.clearTracking(userId);
          }, 60000); // Clear after 1 minute
        }
      }

      // Send content-specific completion event
      sendClientEvent(userId, "content-completed", {
        trainingListId,
        contentType,
        typeName: getContentTypeName(contentType),
        chunks: chunks.length,
      });

      return { success: true, chunks: chunks.length };
    } catch (error) {
      console.error(`Error in pinecone training for type ${contentType}:`, error);
      
      // Update status based on content type
      const updateObj = { trainingStatus: 9, lastEdit: Date.now() }; // Failed
      
      // Add type-specific status update for web pages
      if (contentType === 0) {
        updateObj["webPage.mappingStatus"] = 3; // Failed
      }
      
      await TrainingList.findByIdAndUpdate(trainingListObj._id, updateObj);
      
      // If it's a credits issue, we might want to pause the queue or take specific action
      if (error.message === "INSUFFICIENT_CREDITS") {
        console.log(
          `Pausing processing for user ${userId} due to insufficient credits`
        );
      }

      // Update ScrapeTracker if applicable (for web pages)
      if (contentType === 0 && ScrapeTracker.getTracking(userId)) {
        ScrapeTracker.updateTracking(userId, "training", false);
      }

      return { success: false, error: error.message };
    }
  },
  { connection: redisConfig, concurrency: 5, lockDuration: 30000 }
);

// Worker event handlers
worker.on("completed", (job) => {
  console.log(`Job with id ${job.id} has completed`);
});

worker.on("failed", (job, err) => {
  console.log(`Job with id ${job.id} has failed with error ${err.message}`);

  // If the error is due to insufficient credits, you might want to
  // pause other jobs for the same user to prevent wasteful processing
  if (err.message === "INSUFFICIENT_CREDITS" && job.data) {
    const { trainingListId, type } = job.data;
    console.log(
      `Pausing other jobs related to training list ${trainingListId} (type: ${type}) due to insufficient credits`
    );
    // Implement additional pausing logic here if needed
  }
});

// Function to add jobs to the queue
// async function addTrainingJob(trainingListId) {
//   try {
//     // Fetch the training list to determine its type
//     const trainingList = await TrainingList.findById(trainingListId);
//     if (!trainingList) {
//       throw new Error(`Training list not found: ${trainingListId}`);
//     }

//     const pineconeIndexName = `user-${trainingList.userId}`;
//     const contentType = trainingList.type; // 0-WebPage, 1-File, 2-Snippet, 3-Faq
    
//     // Base job data
//     const jobData = {
//       type: contentType,
//       pineconeIndexName,
//       trainingListId,
//     };
    
//     // Add type-specific data (mainly for backward compatibility with web pages)
//     if (contentType === 0 && trainingList.webPage) {
//       jobData.webPageURL = trainingList.webPage.url;
//       jobData.title = trainingList.webPage.title || trainingList.title;
//       jobData.content = trainingList.webPage.content;
//       jobData.metaDescription = trainingList.webPage.metaDescription;
//     }
    
//     // Update training status
//     const updateObj = { trainingStatus: 1, lastEdit: Date.now() }; // Listed
    
//     // Set appropriate mapping status for web pages
//     if (contentType === 0) {
//       updateObj["webPage.mappingStatus"] = 1; // In Progress
//     }
    
//     await TrainingList.findByIdAndUpdate(trainingListId, updateObj);
    
//     // Add to queue
//     await pineconeTrainQueue.add('train-content', jobData, {
//       attempts: 3,
//       backoff: {
//         type: 'exponential',
//         delay: 5000,
//       },
//     });
    
//     return { success: true };
//   } catch (error) {
//     console.error(`Failed to add training job for ${trainingListId}:`, error);
//     return { success: false, error: error.message };
//   }
// }

console.log("Pinecone training worker started...");

// Export both queue and helper function
module.exports = {
  pineconeTrainQueue,
};