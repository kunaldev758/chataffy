require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Agent = require("../models/Agent");
const Url = require("../models/Url.js");
const WebsiteData = require("../models/WebsiteData.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");
const TurndownService = require("turndown");
const QdrantVectorStoreManager = require("./QdrantService");

const redisConfig =
  process.env.ENVIRONMENT === "local"
    ? { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null }
    : {
        host: "127.0.0.1",
        port: 6379,
        password: "root1234",
        maxRetriesPerRequest: null,
      };

// Helper function to extract website metadata from HTML
const extractWebsiteMetadata = ($, url) => {
  const metadata = {
    company_name: "",
    company_type: "",
    industry: "",
    founded_year: "",
    services_list: [],
    value_proposition: "",
    does_not_list: [],
    website_url: url,
    domain: new URL(url).hostname,
  };

  try {
    // Extract company name from various sources
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
    const siteName = $('meta[property="og:site_name"]').attr("content")?.trim();
    
    // Try to extract company name (remove common suffixes)
    metadata.company_name = 
      siteName || 
      ogTitle || 
      title.split("|")[0].split("-")[0].trim() || 
      h1 || 
      title;

    // Extract company type from meta tags or content
    const keywords = $('meta[name="keywords"]').attr("content")?.toLowerCase() || "";
    const description = $('meta[name="description"]').attr("content")?.toLowerCase() || "";
    const combinedText = (keywords + " " + description).toLowerCase();

    // Detect company type
    if (combinedText.includes("saas") || combinedText.includes("software")) {
      metadata.company_type = "SaaS company";
    } else if (combinedText.includes("e-commerce") || combinedText.includes("online store") || combinedText.includes("shop")) {
      metadata.company_type = "e-commerce platform";
    } else if (combinedText.includes("service") || combinedText.includes("consulting")) {
      metadata.company_type = "service provider";
    } else if (combinedText.includes("agency")) {
      metadata.company_type = "agency";
    } else {
      metadata.company_type = "company";
    }

    // Extract industry
    const industryKeywords = {
      "technology": ["tech", "software", "it", "saas", "platform"],
      "healthcare": ["health", "medical", "hospital", "clinic", "wellness"],
      "real estate": ["real estate", "property", "realty", "housing", "realty"],
      "finance": ["finance", "financial", "banking", "investment", "fintech"],
      "education": ["education", "learning", "school", "university", "course"],
      "retail": ["retail", "store", "shop", "e-commerce", "shopping"],
    };

    for (const [industry, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some(keyword => combinedText.includes(keyword))) {
        metadata.industry = industry;
        break;
      }
    }

    // Extract founded year from footer or content
    const footerText = $("footer").text();
    const bodyText = $("body").text();
    const yearMatch = (footerText + " " + bodyText).match(/(?:founded|established|since|©)\s*(?:in\s*)?(\d{4})/i);
    if (yearMatch) {
      metadata.founded_year = yearMatch[1];
    }

    // Extract services from navigation, services section, or meta tags
    const services = new Set();
    
    // Check navigation links
    $("nav a, header a").each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (text && !text.match(/^(home|about|contact|blog|login|sign up|sign in)$/i)) {
        if (text.length < 50) { // Reasonable service name length
          services.add($(el).text().trim());
        }
      }
    });

    // Check for services section
    $('[class*="service"], [id*="service"], [class*="product"], [id*="product"]').each((_, el) => {
      const text = $(el).text().trim();
      const headings = $(el).find("h2, h3, h4").map((_, h) => $(h).text().trim()).get();
      headings.forEach(heading => {
        if (heading.length < 50 && heading.length > 3) {
          services.add(heading);
        }
      });
    });

    metadata.services_list = Array.from(services).slice(0, 10); // Limit to 10 services

    // Extract value proposition from meta description or hero section
    const metaDesc = $('meta[name="description"]').attr("content")?.trim();
    const heroText = $('[class*="hero"], [class*="banner"], [class*="headline"]').first().text().trim();
    
    metadata.value_proposition = metaDesc || heroText.substring(0, 200) || "";

    // Extract "does not" list - this is harder to extract automatically
    // We'll leave it empty for now, can be manually filled or enhanced later
    metadata.does_not_list = [];

  } catch (error) {
    console.error("Error extracting website metadata:", error);
  }

  return metadata;
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

    // Extract website metadata (from homepage-like URLs or we'll extract from first URL)
    let websiteMetadata = null;
    const urlPath = new URL(url).pathname;
    const isHomepage = urlPath === '/' || 
                      urlPath === '' || 
                      urlPath.split('/').filter(p => p).length <= 1; // Root or one-level deep
    
    // Always extract metadata (we'll decide whether to use it based on homepage status)
    const $meta = cheerio.load(sourceCode);
    websiteMetadata = extractWebsiteMetadata($meta, url);
    
    // Mark if this is homepage for priority
    if (isHomepage) {
      websiteMetadata._isHomepage = true;
    }

    return {
      content: cleanContent,
      webPageURL,
      title,
      metaDescription,
      websiteMetadata, // Include metadata if this is homepage
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
    const { urls, userId,agentId, qdrantIndexName, plan, sitemapUrl, startTime, totalUrls } = job.data;
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
      let metadataExtracted = false; // Track if metadata has been extracted
      
      // Use startTime from job data or current time as fallback
      const scrapingStartTime = startTime ? new Date(startTime) : new Date();
      const totalUrlsCount = totalUrls || urls.length;
      let lastProgressEmitTime = Date.now();
      const PROGRESS_EMIT_INTERVAL = 2000; // Emit progress every 2 seconds

      // Helper function to calculate and emit progress
      const emitProgress = async (currentIndex, totalCount, isProcessing = true) => {
        const now = Date.now();
        const elapsedTime = Math.floor((now - scrapingStartTime.getTime()) / 1000); // seconds
        const percentage = totalCount > 0 ? Math.round((currentIndex / totalCount) * 100) : 0;
        
        // Calculate estimated time remaining
        let estimatedTimeRemaining = null;
        if (currentIndex > 0 && elapsedTime > 0) {
          const avgTimePerUrl = elapsedTime / currentIndex;
          const remainingUrls = totalCount - currentIndex;
          estimatedTimeRemaining = Math.round(remainingUrls * avgTimePerUrl);
        }

        // Format time as HH:MM:SS
        const formatTime = (seconds) => {
          const hrs = Math.floor(seconds / 3600);
          const mins = Math.floor((seconds % 3600) / 60);
          const secs = seconds % 60;
          return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        };

        // Emit progress update
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress: {
            percentage,
            processed: currentIndex,
            total: totalCount,
            elapsedTime: formatTime(elapsedTime),
            elapsedSeconds: elapsedTime,
            estimatedTimeRemaining: estimatedTimeRemaining ? formatTime(estimatedTimeRemaining) : null,
            estimatedSecondsRemaining: estimatedTimeRemaining,
            isProcessing,
          },
        });
      };

      // Emit initial progress
      await emitProgress(0, totalUrlsCount, true);

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          console.log("Processing URL :",url);

           // Extend lock by updating progress
          await job.updateProgress({ current: i + 1, total: urls.length });
          
          // Emit progress updates periodically (every 2 seconds or every URL)
          const now = Date.now();
          if (now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL || i === 0 || i === urls.length - 1) {
            await emitProgress(i + 1, totalUrlsCount, true);
            lastProgressEmitTime = now;
          }

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
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: "",
              dataSize: 0,
              trainingStatus: 2,
              error: "No data found",
              "webPage.url": url,
              chunkCount: 0,
              lastEdit: Date.now(),
            });
            await Url.updateOne(
              { url:url, agentId:agentId },
              {
                $set: {
                  trainStatus: 2,
                  error: "Failed to process/minify web page content",
                },
              }
            );
            continue;
          }

          const { content, title, metaDescription, webPageURL, websiteMetadata } = processResult;

          // Store website metadata if extracted
          // Priority: homepage > first URL > any URL with company_name
          if (websiteMetadata && !metadataExtracted) {
            // Prefer homepage metadata, but use first URL if no homepage found
            const shouldStore = websiteMetadata._isHomepage || 
                               (i === 0) || 
                               (websiteMetadata.company_name && !metadataExtracted);
            
            if (shouldStore) {
              try {
                let websiteData = await WebsiteData.getOrCreate({
                  userId,
                  ...(agentId ? { agentId } : {}),
                });
                // Remove internal flag before storing
                const { _isHomepage, ...cleanMetadata } = websiteMetadata;
                await websiteData.updateData({
                  ...cleanMetadata,
                  website_url: cleanMetadata.website_url || url,
                  domain: cleanMetadata.domain || new URL(url).hostname,
                });
                metadataExtracted = true; // Mark as extracted to avoid overwriting
                console.log(`[jobService] Stored website metadata for user ${userId} from ${url}`);
              } catch (metadataError) {
                console.error(`[jobService] Error storing website metadata:`, metadataError);
                // Don't fail the job if metadata storage fails
              }
            }
          }

          const contentSize = Buffer.byteLength(content, "utf8");

            let clientDoc = await Client.findOne({ userId });
            currentDataSize = clientDoc?.currentDataSize || 0;

          if (currentDataSize + contentSize > plan.limits.maxStorage) {
            await Client.updateOne(
              { userId },
              { $set: { "upgradePlanStatus.storageLimitExceeded": true } }
            );
            
            // Emit progress before stopping due to storage limit
            const storageLimitElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
            const formatTimeForLimit = (seconds) => {
              const hrs = Math.floor(seconds / 3600);
              const mins = Math.floor((seconds % 3600) / 60);
              const secs = seconds % 60;
              return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            };
            
            appEvents.emit("userEvent", agentId, "training-event", {
              agent: await Agent.findOne({ _id: agentId }),
              client: await Client.findOne({ userId }),
              message:
                "Storage limit exceede scrapping Stopped Upgrage Plan to continue",
              scrapingProgress: {
                percentage: totalUrlsCount > 0 ? Math.round(((i + 1) / totalUrlsCount) * 100) : 0,
                processed: i + 1,
                total: totalUrlsCount,
                elapsedTime: formatTimeForLimit(storageLimitElapsedTime),
                elapsedSeconds: storageLimitElapsedTime,
                estimatedTimeRemaining: null,
                estimatedSecondsRemaining: null,
                isProcessing: false,
                stoppedReason: "storage_limit_exceeded",
              },
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
          await TrainingModel.findOneAndUpdate(
            { userId, agentId, "webPage.url": url },
            {
              trainingStatus: 2, // Error
              lastEdit: Date.now(),
              error: error?.message,
            }
          );
          await Agent.updateOne(
            { _id: agentId },
            { $inc: { "pagesAdded.failed": 1 } }
          );
          await Url.updateOne(
            { url:url, agentId:agentId },
            {
              $set: {
                trainStatus: 2,
                error: "Failed to train",
              },
            }
          );
        }
      }

      // Emit progress after all URLs are scraped (before training phase)
      const scrapedElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
      const formatTimeAfterScrape = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      
      await emitProgress(urls.length, totalUrlsCount, true);
      
      // Emit update indicating training phase is starting
      if (scrapedDocs.length > 0) {
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress: {
            percentage: 100,
            processed: urls.length,
            total: totalUrlsCount,
            elapsedTime: formatTimeAfterScrape(scrapedElapsedTime),
            elapsedSeconds: scrapedElapsedTime,
            estimatedTimeRemaining: null,
            estimatedSecondsRemaining: null,
            isProcessing: true,
            phase: "training", // Indicates we're in training phase now
          },
        });
      }

      //make this a queue
      let result = await batchService.processDocumentAndTrain(
        scrapedDocs,
        userId,
        agentId,
        qdrantIndexName
      );
   
      // Handle training failure
      if (!result.success) {
        // Mark all documents as failed if training failed
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: error?.message,
        });
      } else {
        // 3️⃣ Update training status in DB
        for (const doc of scrapedDocs) {
          const status = result?.failedUrls?.includes(doc.originalUrl) ? 2 : 1;
          if(status == 1){
          await TrainingModel.create({
            userId,
            agentId,
            type: 0,
            content: doc.content,
            dataSize: doc.dataSize,
            trainingStatus: status,
            "webPage.url": doc.originalUrl,
            chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
            lastEdit: Date.now(),
          });
        }else if(status == 2){
          await TrainingModel.create({
            userId,
            agentId,
            type: 0,
            content: doc.content,
            dataSize: doc.dataSize,
            trainingStatus: status,
            error: "Failed to process/minify web page content",
            "webPage.url": doc.originalUrl,
            chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
            lastEdit: Date.now(),
          });
          await Url.updateOne(
            { url:doc.originalUrl, agentId:agentId },
            {
              $set: {
                trainStatus: status,
                error: "Failed to process/minify web page content",
              },
            }
          );
        }else{
          await Url.updateOne(
            { url:doc.originalUrl, agentId:agentId },
            {
              $set: {
                trainStatus: status,
                // error: "Failed to process/minify web page content",
              },
            }
          );
        }

          await Agent.updateOne(
            { _id: agentId },
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
          await Agent.updateOne({ _id: agentId }, { $set: { isSitemapAdded: 1 } });
        }
      }

      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0, scrapingStartTime: null,lastTrained: new Date() } });
      
      // Emit final progress (100%)
      const finalElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress: {
          percentage: 100,
          processed: totalUrlsCount,
          total: totalUrlsCount,
          elapsedTime: formatTime(finalElapsedTime),
          elapsedSeconds: finalElapsedTime,
          estimatedTimeRemaining: null,
          estimatedSecondsRemaining: null,
          isProcessing: false,
        },
      });
    } catch (error) {
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0, scrapingStartTime: null } });
      
      // Calculate progress even on error
      const errorElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      
      // Try to get current progress from URL count
      const processedCount = await Url.countDocuments({ userId, agentId:agentId, trainStatus: { $in: [1, 2] } });
      
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
        scrapingProgress: {
          percentage: totalUrlsCount > 0 ? Math.round((processedCount / totalUrlsCount) * 100) : 0,
          processed: processedCount,
          total: totalUrlsCount,
          elapsedTime: formatTime(errorElapsedTime),
          elapsedSeconds: errorElapsedTime,
          estimatedTimeRemaining: null,
          estimatedSecondsRemaining: null,
          isProcessing: false,
          error: true,
        },
      });
      console.log(error);
    }
  },
  { connection: redisConfig, concurrency: 1 }
);

// Delete training data queue - runs in background
const deleteTrainingDataQueue = new Queue("deleteTrainingDataQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "deleteTrainingDataQueue",
  async (job) => {
    const { entries, userId, agentId, qdrantIndexName, TrainingModelName } = job.data;
    const QdrantVectorStoreManager = require("./QdrantService");
    const PlanService = require("./PlanService");
    const Client = require("../models/Client");
    const Agent = require("../models/Agent");
    const appEvents = require("../events");

    try {
      const TrainingModel =
        TrainingModelName === "TrainingListFreeUsers"
          ? require("../models/TrainingListFreeUsers")
          : require("../models/OpenaiTrainingList");

      let totalDataSizeRemoved = 0;
      let pagesSuccessDeleted = 0;
      let pagesFailedDeleted = 0;
      let filesDeleted = 0;
      let faqsDeleted = 0;

      // Delete vectors from Qdrant
      const qdrantResult = await QdrantVectorStoreManager.deleteVectorsByTrainingEntries(
        qdrantIndexName,
        entries.map((e) => ({
          userId: e.userId?.toString(),
          agentId: e.agentId?.toString(),
          type: e.type,
          url: e.webPage?.url,
          title: e.title,
        }))
      );

      if (qdrantResult.errors?.length > 0) {
        console.warn("[deleteTrainingData] Qdrant delete warnings:", qdrantResult.errors);
      }

      // Delete from MongoDB and aggregate stats
      for (const entry of entries) {
        await TrainingModel.deleteOne({ _id: entry._id });
        totalDataSizeRemoved += entry.dataSize || 0;
        if (entry.type === 0) {
          if (entry.trainingStatus === 1) pagesSuccessDeleted++;
          else pagesFailedDeleted++;
        } else if (entry.type === 1) filesDeleted++;
        else if (entry.type === 3) faqsDeleted++;
      }

      // Update Client currentDataSize
      // await Client.updateOne(
      //   { userId },
      //   { $inc: { currentDataSize: -Math.max(0, totalDataSizeRemoved) } }
      // );

      // Update Agent counters
      const updateFields = {};
      if (pagesSuccessDeleted > 0) updateFields["pagesAdded.success"] = -pagesSuccessDeleted;
      if (pagesFailedDeleted > 0) updateFields["pagesAdded.failed"] = -pagesFailedDeleted;
      if (pagesSuccessDeleted > 0 || pagesFailedDeleted > 0) {
        updateFields["pagesAdded.total"] = -(pagesSuccessDeleted + pagesFailedDeleted);
      }
      if (filesDeleted > 0) updateFields.filesAdded = -filesDeleted;
      if (faqsDeleted > 0) updateFields.faqsAdded = -faqsDeleted;
      if (Object.keys(updateFields).length > 0) {
        await Agent.updateOne({ _id: agentId }, { $inc: updateFields });
      }

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      console.log(`[deleteTrainingData] Deleted ${entries.length} training entries for user ${userId}`);
    } catch (error) {
      console.error("[deleteTrainingData] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 }
);

// Retrain training data queue - only webpages (type 0)
const retrainTrainingDataQueue = new Queue("retrainTrainingDataQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "retrainTrainingDataQueue",
  async (job) => {
    const { entries, userId, agentId, qdrantIndexName, TrainingModelName } = job.data;
    const batchService = new batchTrainingService();
    const Agent = require("../models/Agent");

    const TrainingModel =
      TrainingModelName === "TrainingListFreeUsers"
        ? require("../models/TrainingListFreeUsers")
        : require("../models/OpenaiTrainingList");

    try {
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 1 } });
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      const footerCache = {};
      let successCount = 0;
      let failCount = 0;

      for (const entry of entries) {
        const url = entry.webPage?.url;
        if (!url) continue;

        try {
          // 1. Delete old vectors from Qdrant
          const qdrantManager = new QdrantVectorStoreManager(qdrantIndexName);
          await qdrantManager.deleteByFields({
            user_id: userId,
            agent_id: agentId,
            url,
          });

          // 2. Scrape webpage
          const response = await axios.get(url, {
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)" },
          });
          const processResult = await processWebPage(url, response?.data, footerCache);

          if (!processResult?.content) {
            await TrainingModel.updateOne(
              { _id: entry._id },
              {
                $set: {
                  trainingStatus: 2,
                  error: "Failed to process/minify web page content",
                  lastEdit: new Date(),
                },
              }
            );
            failCount++;
            continue;
          }

          const { content, title, metaDescription, webPageURL } = processResult;
          const contentSize = Buffer.byteLength(content, "utf8");
          const oldDataSize = entry.dataSize || 0;
          const dataSizeDelta = contentSize - oldDataSize;

          // 3. Update MongoDB
          const scrapedDoc = {
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
          };

          // 4. Upsert vectors to Qdrant
          const result = await batchService.processDocumentAndTrain(
            [scrapedDoc],
            userId,
            agentId,
            qdrantIndexName
          );

          if (!result.success) {
            await TrainingModel.updateOne(
              { _id: entry._id },
              {
                $set: {
                  trainingStatus: 2,
                  error: result.error || "Failed to upsert vectors",
                  lastEdit: new Date(),
                },
              }
            );
            failCount++;
            continue;
          }

          // 5. Update MongoDB with new content and status
          await TrainingModel.updateOne(
            { _id: entry._id },
            {
              $set: {
                content,
                dataSize: contentSize,
                trainingStatus: 1,
                lastEdit: new Date(),
                chunkCount: result.totalChunks || 0,
                "webPage.url": url,
              },
            }
          );

          // 6. Increment currentDataSize (delta: new - old)
          await Client.updateOne(
            { userId },
            { $inc: { currentDataSize: dataSizeDelta } }
          );

          successCount++;
        } catch (err) {
          console.error(`[retrainTrainingData] Error retraining ${url}:`, err);
          await TrainingModel.updateOne(
            { _id: entry._id },
            {
              $set: {
                trainingStatus: 2,
                error: err?.message || "Scraping failed",
                lastEdit: new Date(),
              },
            }
          );
          failCount++;
        }
      }

      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      console.log(`[retrainTrainingData] Completed: ${successCount} success, ${failCount} failed for user ${userId}`);
    } catch (error) {
      console.error("[retrainTrainingData] Job failed:", error);
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
      });
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 1 }
);

const transcriptEmailQueue = new Queue("transcriptEmailQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "transcriptEmailQueue",
  async (job) => {
    const { conversation } = job.data || {};
    try {
      if (!conversation?._id || !conversation?.userId) {
        console.warn("[transcriptEmailQueue] Missing conversation data, skipping job");
        return;
      }

      const { sendConversationTranscriptEmail } = require("../helpers/visitorHandlers");
      await sendConversationTranscriptEmail(conversation);
      console.log(`[transcriptEmailQueue] Transcript email sent for conversation ${conversation._id}`);
    } catch (error) {
      console.error("[transcriptEmailQueue] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 }
);

module.exports = {
  planUpgradeQueue,
  urlProcessingQueue,
  deleteTrainingDataQueue,
  retrainTrainingDataQueue,
  transcriptEmailQueue,
};
