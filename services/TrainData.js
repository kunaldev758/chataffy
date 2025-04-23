require("dotenv").config();
const { Worker, Queue } = require("bullmq");
const redis = require("redis");
const Client = require("../models/Client");
const VectorStoreManager = require("./PineconeService"); // Assuming this handles Pinecone interaction
const { MarkdownTextSplitter } = require("langchain/text_splitter");
const TrainingList = require("../models/OpenaiTrainingList");
const OpenAIUsageController = require("../controllers/OpenAIUsageController");
const UnifiedPricingService = require("./UnifiedPricingService"); // Import the new service
const ScrapeTracker = require("./ScrapeTracker");
const appEvents = require("../events.js");


const redisConfig = process.env.ENVIRONMENT =='local' ? {
  url: process.env.REDIS_URL,
  maxRetriesPerRequest: null,
}:
redis.createClient({
  url: "redis://:root1234@localhost:6379"
})

// const redisConfig = {
//   url: process.env.REDIS_URL,
//   maxRetriesPerRequest: null,
// };

const pineconeTrainQueue = new Queue("pineconeTraining", {
  connection: redisConfig,
});

// Send event to client
function sendClientEvent(userId, eventName, data) {
  appEvents.emit("userEvent", userId, eventName, { data });
}

// Initialize pricing service once
// TODO: Determine Pinecone tier/pod type dynamically if needed, or use defaults/config
const pricingService = new UnifiedPricingService(process.env.PINECONE_TIER || 'standard', process.env.PINECONE_POD_TYPE || 's1');
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'; // Define embedding model used

// Check user credits before processing
async function checkUserCredits(userId, estimatedCost) {
  try {
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
async function recordUsage(userId, totalTokens) {
  try {
    // Assuming recordUsage expects these specific details
    const result = await OpenAIUsageController.recordUsage(
      userId,
      "train-data", // Operation type
      {
        totalTokens,
        embeddingTokens: totalTokens, // Assuming embedding tokens are the same as total tokens for this operation
        embeddingModel: EMBEDDING_MODEL, // Pass the actual model used
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
      type,
      pineconeIndexName,
      trainingListId,
      // Other props
    } = job.data;

    console.log(`Processing job for trainingListId: ${trainingListId}, type: ${type}`);
    let userId = null;
    let trainingListObj; // Define here for broader scope

    try {
      // Fetch the TrainingList object
      trainingListObj = await TrainingList.findOne({ _id: trainingListId }); // Assign to the broader scope variable

      if (!trainingListObj) {
        console.error(`TrainingList not found with id: ${trainingListId}`);
        throw new Error("Training list not found");
      }

      userId = trainingListObj.userId;
      let contentToProcess = "";
      let metadata = { userId: userId }; // Always include userId
      const contentType = parseInt(type);
      let title = "Untitled"; // Default title

      // Extract content and metadata based on content type
      switch (contentType) {
        case 0: // WebPage
          contentToProcess = job.data.content;
          title = job.data.title || job.data.webPageURL;
          metadata = {
            ...metadata,
            url: job.data.webPageURL,
            title: title,
            type: "webpage",
            metaDescription: job.data.metaDescription,
          };
          break;

        case 1: // File
          contentToProcess = job.data.content;
          title = job.data.title || job.data.originalFileName;
          metadata = {
            ...metadata,
            fileName: job.data.fileName,
            originalFileName: job.data.originalFileName,
            title: title,
            type: "file",
          };
          break;

        case 2: // Snippet
          contentToProcess = job.data.content;
          title = job.data.title || "Snippet";
          metadata = {
            ...metadata,
            title: title,
            type: "snippet",
          };
          break;

        case 3: // FAQ
          // Combine question (title) and answer (content)
          title = job.data.title || "FAQ";
          contentToProcess = `Question: ${job.data.title}\nAnswer: ${job.data.content}`;
          metadata = {
            ...metadata,
            question: job.data.title, // Keep original question here
            title: title, // Use a combined title or just the question
            type: "faq",
          };
          break;

        default:
          throw new Error(`Unsupported content type: ${contentType}`);
      }

      if (!contentToProcess) {
        console.warn(`No content found for trainingListId ${trainingListId}, type ${contentType}. Skipping.`);
        // Optionally update status to indicate no content or skip
         await TrainingList.findByIdAndUpdate(trainingListObj._id, {
            trainingStatus: 5, // Or a new status like 'No Content'
            lastEdit: Date.now(),
         });
         sendClientEvent(userId, "content-skipped-no-content", {
            trainingListId, contentType, typeName: getContentTypeName(contentType),
         });
        return { success: true, skipped: true, reason: "No content" };
      }

      // --- Cost Calculation ---
      // Use the new pricing service
      const totalTokens = pricingService.estimateTokens(contentToProcess);
      const embeddingCost = pricingService.calculateEmbeddingCost(totalTokens, EMBEDDING_MODEL);
      // --- End Cost Calculation ---

      console.log(`Estimated cost for ${trainingListId}: Tokens=${totalTokens}, Cost=${embeddingCost.toFixed(6)}`);

      // Check if user has enough credits
      const hasCredits = await checkUserCredits(userId, embeddingCost);
      if (!hasCredits) {
        const updateObj = { trainingStatus: 10, lastEdit: Date.now() }; // Insufficient Credits status
        if (contentType === 0) updateObj["webPage.mappingStatus"] = 3; // Failed

        await TrainingList.findByIdAndUpdate(trainingListObj._id, updateObj);

        sendClientEvent(userId, "content-error-insufficient-credits", {
          trainingListId,
          contentType,
          typeName: getContentTypeName(contentType),
          error: "Insufficient credits to process this content",
        });

        throw new Error("INSUFFICIENT_CREDITS");
      }

      // Initialize VectorStoreManager (ensure it uses the correct index name)
      const vectorStoreManager = new VectorStoreManager(pineconeIndexName);

      // Check/Create Pinecone Index (Consider doing this less frequently, perhaps on client setup)
      if (!(await vectorStoreManager.doesIndexExist(pineconeIndexName))) {
        console.log(`Creating index "${pineconeIndexName}"...`);
        const created = await vectorStoreManager.createIndex(pineconeIndexName);
        if (!created) {
          throw new Error("Failed to create Pinecone index"); // Let the main error handler catch this
        }
      }

      // Configure text splitter
      let chunkSize = 1000;
      let chunkOverlap = 200;
      if (contentType === 3) { // FAQ
        chunkSize = 2000;
        chunkOverlap = 150;
      } else if (contentType === 2) { // Snippet
        chunkSize = 1500;
        chunkOverlap = 150;
      }

      const textSplitter = new MarkdownTextSplitter({ chunkSize, chunkOverlap });
      // Pass metadata *object* to createDocuments for association with each chunk
      const documents = await textSplitter.createDocuments([contentToProcess], [metadata]); // Pass metadata as the second arg


      // Record usage *before* the expensive upsert operation
      await recordUsage(userId, totalTokens); // Pass calculated cost

      // Upsert vectors into Pinecone
      if (documents.length > 0) {
          // Assuming upsertVectors takes LangChain documents directly
          // or adapts them internally. Adjust if it expects plain text/metadata separately.
          // Ensure your VectorStoreManager correctly handles embedding and upserting
          // Langchain Documents which contain both pageContent and metadata.
          const upsertResult = await vectorStoreManager.upsertDocuments(documents); // Changed method name assumption

        if (!upsertResult || !upsertResult.success) { // Check for success flag
            console.error("Failed to upsert vectors:", upsertResult?.error);
            throw new Error("Failed to upsert vectors: " + (upsertResult?.error || "Unknown error"));
        }
        console.log(`Upserted ${documents.length} chunks for ${trainingListId}`);
      } else {
        console.log(`No chunks generated for ${trainingListId}, nothing to upsert.`);
      }

      // Update training list with successful status
      const updateSuccessObj = {
        // You might want to store calculated cost/tokens here if needed for display
        // costDetails: { tokens: totalTokens, embeddingCost: embeddingCost },
        trainingStatus: 4, // Mapped
        lastEdit: Date.now(),
      };
      if (contentType === 0) updateSuccessObj["webPage.mappingStatus"] = 2; // Success

      await TrainingList.findByIdAndUpdate(trainingListObj._id, updateSuccessObj);

      // Handle ScrapeTracker for web pages
      if (contentType === 0) {
         const trackingInfo = ScrapeTracker.getTracking(userId);
         if (trackingInfo) {
            ScrapeTracker.updateTracking(userId, "training", true);
            const updatedTrackingInfo = ScrapeTracker.getTracking(userId); // Get fresh data
             const isComplete =
              updatedTrackingInfo.trainingCompleted + updatedTrackingInfo.failedPages >=
              updatedTrackingInfo.totalPages;

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

            if (isComplete) {
                 await Client.updateOne({ userId: userId }, { webPageAdded: true });
                 appEvents.emit("userEvent", userId, "scraping-complete", {
                  total: trackingInfo.totalPages,
                  processed: trackingInfo.trainingCompleted,
                  failed: trackingInfo.failedPages,
                  duration: Date.now() - trackingInfo.startTime,
                });
                 setTimeout(() => ScrapeTracker.clearTracking(userId), 60000);
            }
        }
      }

      sendClientEvent(userId, "content-completed", {
        trainingListId,
        contentType,
        typeName: getContentTypeName(contentType),
        chunks: documents.length,
      });

      return { success: true, chunks: documents.length };

    } catch (error) {
      console.error(`Error processing job ${job.id} (TLID: ${trainingListId}, Type: ${type}):`, error.message);

      // Ensure userId and trainingListObj are available for error handling
      userId = userId || job.data.userId || trainingListObj?.userId; // Try to get userId
      const listId = trainingListId || job.data.trainingListId;

      if (listId && userId) {
        const updateErrorObj = { trainingStatus: 9, lastEdit: Date.now() }; // Failed status
        const contentType = parseInt(type); // Re-parse type if needed
         if (!isNaN(contentType) && contentType === 0) {
             updateErrorObj["webPage.mappingStatus"] = 3; // Failed for webpage
         }
        try {
             await TrainingList.findByIdAndUpdate(listId, updateErrorObj);
        } catch (updateError) {
            console.error(`Failed to update TrainingList status to failed for ${listId}:`, updateError);
        }

         // Update ScrapeTracker on failure for web pages
         if (!isNaN(contentType) && contentType === 0) {
            const trackingInfo = ScrapeTracker.getTracking(userId);
            if (trackingInfo) {
               ScrapeTracker.updateTracking(userId, "training", false); // Mark as failed
               // Potentially check completion status here too, similar to success path
            }
         }

         // Send specific error event to client
         const errorType = error.message === "INSUFFICIENT_CREDITS"
            ? "content-error-insufficient-credits"
            : "content-error";

         sendClientEvent(userId, errorType, {
            trainingListId: listId,
            contentType: isNaN(contentType) ? 'unknown' : contentType,
            typeName: isNaN(contentType) ? 'unknown' : getContentTypeName(contentType),
            error: error.message,
         });

      } else {
          console.error(`Cannot update status or notify client: userId (${userId}) or trainingListId (${listId}) is missing.`);
      }

      // Rethrow the error to mark the job as failed in BullMQ
      throw error; // Don't return { success: false } here, let BullMQ handle the failure
    }
  },
  { connection: redisConfig, concurrency: 5, lockDuration: 60000 } // Increased lock duration
);

// --- Worker Event Handlers ---
worker.on("completed", (job, result) => {
  console.log(`Job ${job.id} (TLID: ${job.data.trainingListId}) completed. Result: ${JSON.stringify(result)}`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job.id} (TLID: ${job.data.trainingListId}) failed with error: ${err.message}`, err.stack);
  // Specific handling for insufficient credits if needed (e.g., pausing user's queue)
  if (err.message === "INSUFFICIENT_CREDITS" && job?.data?.userId) {
      console.warn(`Insufficient credits detected for user ${job.data.userId}. Consider pausing related jobs.`);
      // Potential logic to pause queue for this user
  }
});

worker.on("error", (err) => {
  console.error("Worker encountered an error:", err);
});

console.log("Pinecone training worker started...");

module.exports = { pineconeTrainQueue }; // Only export the queue usually