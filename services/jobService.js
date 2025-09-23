require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Url = require("../models/Url.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");
const QdrantVectorStoreManager = require("./QdrantService");

const redisConfig =
  process.env.ENVIRONMENT === "local"
    ? { url: process.env.REDIS_URL, maxRetriesPerRequest: null }
    : {
        host: "127.0.0.1",
        port: 6379,
        password: "root1234",
        maxRetriesPerRequest: null,
      };

const processWebPage = async (url, sourceCode) => {
  try {
    const $ = cheerio.load(sourceCode);
    const webPageURL = url;
    const allowedTags = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "a",
      "strong",
      "em",
      "span",
      "div",
    ];

    // Handle singular tags appropriately
    const title = $("title").text().trim();
    const metaDescription = $('meta[name="description"]').attr("content") || "";

    // Remove unwanted elements
    $("br, hr, style, script, noscript, iframe").remove();

    // Remove comments
    $("*")
      .contents()
      .filter(function () {
        return this.nodeType === 8;
      })
      .remove();

    // Handle images and inputs
    $("img, input, button, select, textarea").remove();

    // Function to convert relative URLs to absolute
    function convertToAbsoluteUrl(relativeUrl, baseUrl) {
      return urlModule.resolve(baseUrl, relativeUrl);
    }

    // Update relative URLs to absolute URLs
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("http") && href !== "#") {
        $(el).attr("href", convertToAbsoluteUrl(href, webPageURL));
      }
    });

    // Replace form elements with a message
    $("form").each((i, el) => {
      $(el).replaceWith(`<p>Form available at: ${webPageURL}</p>`);
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
              } else {
                // Replace with text content if multiple children or no children
                const textContent = $(this).text().trim();
                if (textContent) {
                  $(this).replaceWith(`<p>${textContent}</p>`);
                } else {
                  $(this).remove();
                }
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
            if ($(this).is(":empty") || /^\s*$/.test($(this).text())) {
              $(this).remove();
            }
          }
        });
    }

    removeEmptyElements("body");

    // Trim text content while preserving structure
    $("*").each(function () {
      if ($(this).is("p, h1, h2, h3, h4, h5, h6, li")) {
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

    // Remove unused attributes except for essential ones
    $("*").each(function () {
      const allowedAttributes = ["href", "src", "alt"];
      const attributes = this.attribs;

      for (const attr in attributes) {
        if (attributes[attr] && !allowedAttributes.includes(attr)) {
          delete attributes[attr];
        }
      }
    });

    // Get final processed content
    const content = $("body").html();
    const cleanContent = content ? content.replace(/\s+/g, " ").trim() : "";

    return {
      content: cleanContent,
      webPageURL,
      title: title || webPageURL,
      metaDescription: metaDescription.trim(),
    };
  } catch (error) {
    console.error("Error processing webpage:", error);
    return null;
  }
};

// Create the queue
// Create the queue with better configuration
const planUpgradeQueue = new Queue("planUpgradeQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

// Create the worker with error handling
new Worker(
  "planUpgradeQueue",
  async (job) => {
    const { userId, sourceCollection, targetCollection } = job.data;

    try {
      console.log(`Processing plan upgrade for user: ${userId}`);
      //   await PlanService.migrateFreeUserData(userId);
      const TrainingListFreeUsers = require("../models/TrainingListFreeUsers");
      const TrainingList = require("../models/OpenaiTrainingList");

      const freeUserData = await TrainingListFreeUsers.find({ userId });

      for (const item of freeUserData) {
        const newItem = new TrainingList(item.toObject());
        newItem._id = undefined; // Let MongoDB generate new ID
        await newItem.save();
      }

      const qdrantManager = new QdrantVectorStoreManager(sourceCollection);
      await qdrantManager.migrateCollection(sourceCollection, targetCollection);

      console.log(`Plan upgrade completed for user: ${userId}`);
    } catch (error) {
      console.error(`Plan upgrade failed for user ${userId}:`, error);
      throw error; // Re-throw to mark job as failed
    }
  },
  {
    connection: redisConfig,
    concurrency: 2, // Limit concurrent processing
  }
);

const urlProcessingQueue = new Queue("urlProcessingQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 5,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
  },
});

new Worker(
  "urlProcessingQueue",
  async (job) => {
    const { urls, userId, qdrantIndexName, plan,sitemapUrl } = job.data;
    try {
      const batchService = new batchTrainingService();

      const TrainingListFreeUsers = require("../models/TrainingListFreeUsers");
      const TrainingList = require("../models/OpenaiTrainingList");
      let TrainingModel = TrainingListFreeUsers;
      if (plan.name === "free") {
        TrainingModel = TrainingListFreeUsers;
      } else {
        TrainingModel = TrainingList;
      }

      let scrapedDocs = [];
      let currentDataSize = 0;

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          console.log("Processing URL :",url);

           // Extend lock by updating progress
          await job.updateProgress({ current: i + 1, total: urls.length });

          const response = await axios.get(url, {
            timeout: 30000, // 30 second timeout
            maxContentLength: 50 * 1024 * 1024, // 50MB max
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
            },
          });

          const sourceCode = response?.data;

          const processResult = await processWebPage(url, sourceCode);
          if (!processResult.content) {
            await Url.updateOne(
              { url },
              {
                $set: {
                  trainStatus: 2,
                  error: "Failed to process/minify web page content",
                },
              }
            );
            continue;
          }

          const { content, title, metaDescription, webPageURL } = processResult;

          const contentSize = Buffer.byteLength(content, "utf8");

            let clientDoc = await Client.findOne({ userId });
            currentDataSize = clientDoc?.currentDataSize || 0;

          if (currentDataSize + contentSize > plan.limits.maxStorage) {
            await Client.updateOne(
              { userId },
              { $set: { "upgradePlanStatus.storageLimitExceeded": true } }
            );
            appEvents.emit("userEvent", userId, "training-event", {
              client: await Client.findOne({ userId }),
              message:
                "Storage limit exceede scrapping Stopped Upgrage Plan to continue",
            });
            break;
          } else {
            await Client.updateOne(
              { userId },
              { $inc: { currentDataSize: contentSize } }
            );

            scrapedDocs.push({
              type: 0,
              content,
              dataSize: contentSize,
              metadata: {
                url: webPageURL,
                title,
                metaDescription,
                type: "webpage",
              },
              originalUrl: url,
            });
          }
        } catch (error) {
          await TrainingModel.findByIdAndUpdate(
            { userId: userId, "webPage.url": url },
            {
              trainingStatus: 2, // Error
              lastEdit: Date.now(),
              error: error?.message,
            }
          );
          await Client.updateOne(
            { userId },
            { $inc: { "pagesAdded.failed": 1 } }
          );
          await Url.updateOne(
            { url },
            {
              $set: {
                trainStatus: 2,
                error: "Failed to train",
              },
            }
          );
        }
      }

      //make this a queue
      let result = await batchService.processDocumentAndTrain(
        scrapedDocs,
        userId,
        qdrantIndexName
      );
   
      // Handle training failure
      if (!result.success) {
        // Mark all documents as failed if training failed
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: error?.message,
        });
      } else {
        // 3️⃣ Update training status in DB
        for (const doc of scrapedDocs) {
          const status = result?.failedUrls?.includes(doc.originalUrl) ? 2 : 1;
          await TrainingModel.create({
            userId,
            type: 0,
            content: doc.content,
            dataSize: doc.dataSize,
            trainingStatus: status,
            "webPage.url": doc.originalUrl,
            chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
            lastEdit: Date.now(),
          });
          if(status == 2){
          await Url.updateOne(
            { url:doc.originalUrl },
            {
              $set: {
                trainStatus: status,
                error: "Failed to process/minify web page content",
              },
            }
          );
        }else{
          await Url.updateOne(
            { url:doc.originalUrl },
            {
              $set: {
                trainStatus: status,
                // error: "Failed to process/minify web page content",
              },
            }
          );
        }

          await Client.updateOne(
            { userId },
            {
              $inc: {
                ...(status === 1
                  ? { "pagesAdded.success": 1 }
                  : { "pagesAdded.failed": 1 }),
              },
            }
          );
        }

        if (sitemapUrl) {
          await Client.updateOne({ userId }, { $set: { isSitemapAdded: 1 } });
        }
      }

      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
      });
    } catch (error) {
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
        message: error?.message,
      });
      console.log(error);
    }
  },
  { connection: redisConfig, concurrency: 1 }
);

module.exports = { planUpgradeQueue, urlProcessingQueue };
