// services/webPageMinifier.js
require("dotenv").config();
const { Worker,Queue } = require("bullmq");
const cheerio = require("cheerio");
const TrainingList = require("../models/OpenaiTrainingList");
const pineconeTrainQueue = require("./TrainData");
const urlModule = require("url");
const ScrapeTracker = require("./scrapeTracker");
const appEvents = require('../events.js');

const allowedTags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd","a" ];
const redisConfig = {
    url: process.env.REDIS_URL,
    maxRetriesPerRequest: null,
};
const minifyingQueue = new Queue('webPageMinifying', { connection: redisConfig });  

const worker = new Worker(
  "webPageMinifying",
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
        "webPage.minifyingStatus": 1,
        "webPage.minifyingDuration.start": Date.now(),
      });

      const processResult = await processWebPage(trainingListObj);
      if (processResult) {
        const { content, title,metaDescription,webPageURL } = processResult;

  // Update tracking information
  if (ScrapeTracker.getTracking(pageUserId)) {
    ScrapeTracker.updateTracking(pageUserId, 'minifying', true);
    
    // Get updated tracking info
    const trackingInfo = ScrapeTracker.getTracking(pageUserId);
    
    // Emit progress update
      appEvents.emit('userEvent', pageUserId, 'scraping-progress', {
        status: 'in-progress',
        stage: 'minifying',
        total: trackingInfo.totalPages,
        scrapingCompleted: trackingInfo.scrapingCompleted,
        minifyingCompleted: trackingInfo.minifyingCompleted,
        trainingCompleted: trackingInfo.trainingCompleted,
        failed: trackingInfo.failedPages,
      });
  }

        await pineconeTrainQueue.add("pineconeTraining", {
          type :"webpage", 
          pineconeIndexName, 
          content, 
          webPageURL, 
          title,
          trainingListId,
          metaDescription
        }); // Job Name and data
      } else {
        throw new Error("Failed to process web page");
      }
    } catch (error) {
      console.error(`Error scraping ${url}:`, error);

      await TrainingList.findByIdAndUpdate(trainingListObj._id, {
        "webPage.minifyingStatus": 3,
        lastEdit: Date.now(),
        trainingStatus: 9, // Error
      });

 // Update tracking for failed page
 if (ScrapeTracker.getTracking(pageUserId)) {
  ScrapeTracker.updateTracking(pageUserId, 'minifying', false);
  
  // Get updated tracking info
  const trackingInfo = ScrapeTracker.getTracking(pageUserId);
  
  // Emit progress update
    appEvents.emit('userEvent', pageUserId, 'scraping-progress', {
      status: 'in-progress',
      stage: 'minifying',
      total: trackingInfo.totalPages,
      scrapingCompleted: trackingInfo.scrapingCompleted,
      minifyingCompleted: trackingInfo.minifyingCompleted,
      trainingCompleted: trackingInfo.trainingCompleted,
      failed: trackingInfo.failedPages,
    });
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

async function processWebPage(trainingListObj) {
  try {
    const sourceCode = trainingListObj.webPage.sourceCode;
    const $ = cheerio.load(sourceCode);
    const webPageURL = trainingListObj.webPage.url;

    // Handle singular tags appropriately
    const title = $("title").text();
    const metaDescription = $('meta[name="description"]').attr("content");
    $("br, hr").remove(); // or replace with a suitable representation
    // Remove style, script tags
    $("style, script").remove();
    // Remove comments
    $("*")
      .contents()
      .filter(function () {
        return this.nodeType === 8;
      })
      .remove();
    // Handle other singular tags appropriately
    $("img, input").remove(); // or handle differently based on your requirements

    // Function to convert relative URLs to absolute
    function convertToAbsoluteUrl(relativeUrl, baseUrl) {
      return urlModule.resolve(baseUrl, relativeUrl);
    }

    // Update relative URLs to absolute URLs
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("http") && href !== "#") {
        // !href.startsWith('#')
        $(el).attr("href", convertToAbsoluteUrl(href, webPageURL));
      }
    });

    // Replace iframes with a message or remove them if no src attribute
    $("iframe").each((i, el) => {
      const src = $(el).attr("src");
      if (src) {
        $(el).replaceWith(`${convertToAbsoluteUrl(src, webPageURL)}`);
      } else {
        $(el).remove();
      }
    });

    // Replace form elements with a message
    $("form").each((i, el) => {
      $(el).prepend(`Form on URL: ${webPageURL}`);
    });

    // Replace all tags other than allowed tags with their inner HTML recursively
    function replaceNonAllowedTags(element) {
      $(element)
        .contents()
        .each(function () {
          if (this.nodeType === 1) {
            replaceNonAllowedTags(this);
            // Check if the current node is not in the allowed tag list
            if (!allowedTags.includes(this.name)) {
              // Check if there is exactly 1 immediate child node of type 1
              const childNodes = $(this)
                .children()
                .filter(function () {
                  return this.nodeType === 1;
                });

              if (childNodes.length === 1) {
                // Replace the outer node with its inner HTML
                const innerHtml = $(this).html() || "";
                $(this).replaceWith(innerHtml);
              }
            }
          }
        });
    }
    replaceNonAllowedTags("body");

    // Remove empty elements recursively
    function removeEmptyElements(element) {
      $(element)
        .contents()
        .each(function () {
          if (this.nodeType === 1) {
            removeEmptyElements(this);
            // if ($(this).is(":empty")) {
            if ($(this).is(":empty") || /^\s*$/.test($(this).text())) {
              $(this).remove();
            }
          }
        });
    }
    removeEmptyElements("body");
    $("*").each(function () {
      if ($(this).is("p, h1, h2, h3, h4, h5, h6, li")) {
        // Preserve anchor tags while trimming text
        $(this)
          .contents()
          .filter(function () {
            return this.nodeType === 3; // Filter for text nodes
          })
          .each(function () {
            this.nodeValue = this.nodeValue.trim(); // Trim text content
          });
      }
    });

    // Remove unused attributes
    // $('*').removeAttr('style');
    $("*").each(function () {
      const allowedAttributes = ["src", "href"];

      // Get all attributes of the current element
      const attributes = this.attribs;

      // Check each attribute
      for (const attr in attributes) {
        if (attributes[attr] && !allowedAttributes.includes(attr)) {
          // Remove the non-allowed attributes
          delete attributes[attr];
        }
      }
    });

    const content = $("body").html().replace(/\s+/g, " ").trim();
    return {content,webPageURL,title,metaDescription};
  } catch (error) {
    console.error("Error processing webpage:", error);
  }
}

module.exports = minifyingQueue ;