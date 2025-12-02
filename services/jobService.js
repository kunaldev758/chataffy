require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
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
    ? { url: process.env.REDIS_URL, maxRetriesPerRequest: null }
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
    const { urls, userId, qdrantIndexName, plan, sitemapUrl, startTime, totalUrls } = job.data;
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
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
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
                let websiteData = await WebsiteData.getOrCreate(userId);
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
            
            appEvents.emit("userEvent", userId, "training-event", {
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
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
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

      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0, scrapingStartTime: null } });
      
      // Emit final progress (100%)
      const finalElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
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
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0, scrapingStartTime: null } });
      
      // Calculate progress even on error
      const errorElapsedTime = Math.floor((Date.now() - scrapingStartTime.getTime()) / 1000);
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      
      // Try to get current progress from URL count
      const processedCount = await Url.countDocuments({ userId, trainStatus: { $in: [1, 2] } });
      
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
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

module.exports = { planUpgradeQueue, urlProcessingQueue };
