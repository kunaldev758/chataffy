require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Url = require("../models/Url.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");
const TurndownService = require("turndown");
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


const processWebPage = async (url, sourceCode, footerCache = {}) => {
  try {
    const $ = cheerio.load(sourceCode);
    const webPageURL = url;
    const domain = new URL(webPageURL).hostname;

    // ---- Metadata ----
    const title = $("title").text().trim() || webPageURL;
    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || "";

    // ---- Remove unwanted elements ----
    $("script, style, noscript, iframe, svg, canvas, form, input, button, select, textarea").remove();
    $(".ad, .advertisement, .popup, .modal").remove();

    // ---- Handle footer: scrape once per domain ----
    let footerHTML = "";
    const footer = $("footer").first();

    if (footer.length) {
      const footerText = footer.text().trim();
      if (footerText && !footerCache[domain]) {
        footerCache[domain] = true; // mark as processed
        footerHTML = footer.html();
      }
      footer.remove(); // remove footer from page to prevent duplication
    }

    // ---- Convert relative URLs ----
    $("a, img").each((_, el) => {
      const attr = $(el).is("a") ? "href" : "src";
      const val = $(el).attr(attr);
      if (val && !val.startsWith("http") && !val.startsWith("data:")) {
        $(el).attr(attr, urlModule.resolve(webPageURL, val));
      }
    });

    // ---- Convert images to descriptive text ----
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      const alt = $(el).attr("alt")?.trim();
      if (src) {
        const altText = alt ? ` (${alt})` : "";
        $(el).replaceWith(`<p>Image${altText}: ${src}</p>`);
      }
    });

    // ---- Convert anchor-only links ----
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && !text) {
        $(el).text(`Link: ${href}`);
      }
    });

    // ---- Remove empty or redundant tags ----
    $("*").each((_, el) => {
      const text = $(el).text().trim();
      if (!text && $(el).children().length === 0) {
        $(el).remove();
      }
    });

    // ---- Convert to Markdown ----
    const turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
    });

    let markdown = turndownService.turndown($("body").html() || "");

    // Append footer content once per domain
    if (footerHTML) {
      const footerMarkdown = turndownService.turndown(footerHTML);
      markdown += `\n\n---\n**Footer Links (from ${domain})**\n${footerMarkdown}`;
    }

    // ---- Clean whitespace (preserve structure) ----
    // Replace multiple spaces with single space, but preserve newlines
    const cleanContent = markdown
      .replace(/[ \t]+/g, " ") // Replace multiple spaces/tabs with single space
      .replace(/\n{3,}/g, "\n\n") // Replace 3+ newlines with double newline
      .trim();

    return {
      content: cleanContent,
      webPageURL,
      title,
      metaDescription,
    };
  } catch (error) {
    console.error("Error processing webpage:", error);
    return null;
  }
};

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
      const footerCache = {};

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

          const processResult = await processWebPage(url, sourceCode,footerCache);
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
