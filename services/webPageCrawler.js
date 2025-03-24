// services/webPageCrawler.js
const axios = require("axios");
const { Worker, Queue } = require("bullmq");
const TrainingList = require("../models/OpenaiTrainingList");
const minifyingQueue = require("./webPageMinifier");
const ScrapeTracker = require("./scrapeTracker");
const appEvents = require('../events.js');

const redisConfig = {
  url: "rediss://default:AVNS_hgyd-Akk8_1yNrsH9_U@valkey-26e6c5af-chataffy-kunalagrawal-c505.l.aivencloud.com:10064",
  maxRetriesPerRequest: null,
};
const webPageQueue = new Queue("webPageScraping", { connection: redisConfig });

const worker = new Worker(
  "webPageScraping",
  async (job) => {
    const { trainingListId, pineconeIndexName } = job.data;
    console.log(`Processing job for trainingListId: ${trainingListId}`);
    // Fetch the TrainingList object
    const trainingListObj = await TrainingList.findOne({ _id: trainingListId });

    if (!trainingListObj) {
      console.error(`TrainingList not found with id: ${trainingListId}`);
      return; // Or throw an error to retry the job
    }

    const url = trainingListObj.webPage.url;
    const pageUserId = trainingListObj.userId;

    try {
      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.crawlingStatus": 1,
        "webPage.crawlingDuration.start": Date.now(),
      });

      // Fetch the web page content
      const response = await axios.get(url); // Use axios.get directly
      const sourceCode = response.data;

      // Update the TrainingList object with the fetched content
      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.sourceCode": sourceCode,
        "webPage.crawlingStatus": 2,
        "webPage.crawlingDuration.end": Date.now(),
        trainingStatus: 2,
      });

      console.log(`Successfully scraped: ${url}`);

      // Update tracking information
      if (ScrapeTracker.getTracking(pageUserId)) {
        ScrapeTracker.updateTracking(pageUserId, "scraping", true);

        // Get updated tracking info
        const trackingInfo = ScrapeTracker.getTracking(pageUserId);

        // Calculate overall progress (weight each stage differently)
        // const overallProgress = calculateOverallProgress(trackingInfo);

        // Emit progress update
        // if (global.io) {
          appEvents.emit('userEvent', userId, 'scraping-progress', {
            status: "in-progress",
            stage: "scraping",
            total: trackingInfo.totalPages,
            scrapingCompleted: trackingInfo.scrapingCompleted,
            minifyingCompleted: trackingInfo.minifyingCompleted,
            trainingCompleted: trackingInfo.trainingCompleted,
            failed: trackingInfo.failedPages,
            // overallProgress: overallProgress,
          });
        // }
      }

      await minifyingQueue.add("webPageMinifying", {
        trainingListId,
        pineconeIndexName,
      }); // Job Name and data
    } catch (error) {
      console.error(`Error scraping ${url}:`, error);

      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.crawlingStatus": 3,
        lastEdit: Date.now(),
        trainingStatus: 9, // Error
      });
      // Update tracking for failed page
      if (ScrapeTracker.getTracking(pageUserId)) {
        ScrapeTracker.updateTracking(pageUserId, "scraping", false);

        // Get updated tracking info
        const trackingInfo = ScrapeTracker.getTracking(pageUserId);

        // Emit progress update
        // if (global.io) {
          appEvents.emit('userEvent', userId, 'scraping-progress', {
            status: "in-progress",
            stage: "scraping",
            total: trackingInfo.totalPages,
            scrapingCompleted: trackingInfo.scrapingCompleted,
            minifyingCompleted: trackingInfo.minifyingCompleted,
            trainingCompleted: trackingInfo.trainingCompleted,
            failed: trackingInfo.failedPages,
            // overallProgress: calculateOverallProgress(trackingInfo),
          });
        // }
      }
    }
  },
  { connection: redisConfig, concurrency: 5 }
); // Adjust concurrency as needed

worker.on("completed", (job) => {
  console.log(`Job with id ${job.id} has completed`);
});

worker.on("failed", (job, err) => {
  console.log(`Job with id ${job.id} has failed with error ${err.message}`);
});

console.log("Worker started...");

module.exports = webPageQueue;
