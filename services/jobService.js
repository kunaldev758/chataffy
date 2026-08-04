require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Agent = require("../models/Agent");
const Url = require("../models/Url.js");
const WebsiteData = require("../models/WebsiteData.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const cheerio = require("cheerio");
const webScraper = require("./WebScraper.js");
const QdrantVectorStoreManager = require("./QdrantService");
const { buildTrainingProgressPayload } = require("../utils/trainingProgress.js");
const { saveTrainingObserve } = require("./trainingObserve.js");
const {
  isHomepageUrl,
  isScrapableWebUrl,
  isNonContentPath,
} = require("../utils/webUrlUtils.js");
const { detectWebsiteLanguage } = require("../utils/websiteLanguage");
const {
  classifyWebsiteType,
} = require("./LlamaWebsiteClassifierService");
const { websiteTypeDefinitions, industryKeywords } = require("../utils/jobService/data.js");
const {
  extractByPageType,
  markUrlFetched,
  markUrlProcessed,
  markUrlFailed,
  markUrlSkipped,
  markUrlUnchanged,
  markUrlsQueued,
  checkCanonicalDuplicate,
} = require("./contentPipeline");

const NON_HTML_SKIP_ERROR =
  "Non-HTML URL skipped. Use document upload for PDFs and other files.";

async function markWebUrlScrapeFailed({
  url,
  userId,
  agentId,
  TrainingModel,
  error,
}) {
  const existingFailRow = await TrainingModel.findOne({
    userId,
    agentId,
    "webPage.url": url,
  })
    .select("trainingStatus")
    .lean();
  const prevTrainStatus = existingFailRow?.trainingStatus;

  await TrainingModel.findOneAndUpdate(
    { userId, agentId, "webPage.url": url },
    {
      $set: {
        userId,
        agentId,
        type: 0,
        trainingStatus: 2,
        lastEdit: Date.now(),
        error,
        "webPage.url": url,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  if (prevTrainStatus !== 2) {
    const inc =
      prevTrainStatus === 1
        ? { "pagesAdded.success": -1, "pagesAdded.failed": 1 }
        : { "pagesAdded.failed": 1 };
    await Agent.updateOne({ _id: agentId }, { $inc: inc });
  }

  await markUrlFailed(url, agentId, error);
}

const redisConfig =
  process.env.ENVIRONMENT === "local"
    ? { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null }
    : {
        host: "127.0.0.1",
        port: 6379,
        password: "root1234",
        maxRetriesPerRequest: null,
      };

function companyNameFromDomain(hostname) {
  if (!hostname) return "";
  const host = hostname.replace(/^www\./i, "").trim();
  const label = host.split(".")[0];
  if (!label || label.length < 2) return "";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Helper function to extract website metadata from HTML
const extractWebsiteMetadata = ($, url, { isHomepage = false } = {}) => {
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
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
    const siteName = $('meta[property="og:site_name"]').attr("content")?.trim();
    const domainName = companyNameFromDomain(metadata.domain);

    if (isHomepage) {
      metadata.company_name =
        siteName ||
        ogTitle ||
        title.split("|")[0].split("-")[0].trim() ||
        h1 ||
        title ||
        domainName;
    } else {
      metadata.company_name = siteName || domainName;
    }
    const keywords =
      $('meta[name="keywords"]').attr("content")?.toLowerCase() || "";
    const description =
      $('meta[name="description"]').attr("content")?.toLowerCase() || "";
    const combinedText = (keywords + " " + description).toLowerCase();

    const schemaTypes = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).contents().text() || $(el).text());
        const collect = (node) => {
          if (!node) return;
          if (Array.isArray(node)) return node.forEach(collect);
          if (typeof node === "object") {
            const t = node["@type"];
            if (typeof t === "string") schemaTypes.push(t.toLowerCase());
            else if (Array.isArray(t))
              t.forEach((x) => typeof x === "string" && schemaTypes.push(x.toLowerCase()));
            if (node["@graph"]) collect(node["@graph"]);
          }
        };
        collect(parsed);
      } catch (_) {
       
      }
    });

   
    const classifyText = [title, h1, ogTitle, keywords, description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const scores = {};
    for (const def of websiteTypeDefinitions) {
      let score = 0;
      if (def.schema) {
        for (const s of def.schema) {
          if (schemaTypes.includes(s)) score += 5;
        }
      }
      if (def.keywords) {
        for (const kw of def.keywords) {
          if (classifyText.includes(kw)) score += 1;
        }
      }
      if (score > 0) scores[def.type] = score;
    }

    const bestType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const keywordScore = bestType ? bestType[1] : 0;
    const hasStrongKeywordSignal = Boolean(bestType && keywordScore >= 3);

    if (hasStrongKeywordSignal) {
      metadata.company_type = bestType[0];
      metadata.company_type_source = "keywords";
    } else {
      metadata.company_type = bestType
        ? bestType[0]
        : "Business/Corporate Website";
      metadata._needsLlamaTypeClassification = true;
      metadata._schemaTypes = schemaTypes;
    }

    for (const [industry, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some((keyword) => combinedText.includes(keyword))) {
        metadata.industry = industry;
        break;
      }
    }

    // Extract founded year from footer or content
    const footerText = $("footer").text();
    const bodyText = $("body").text();
    const yearMatch = (footerText + " " + bodyText).match(
      /(?:founded|established|since|©)\s*(?:in\s*)?(\d{4})/i,
    );
    if (yearMatch) {
      metadata.founded_year = yearMatch[1];
    }

    // Extract services from navigation, services section, or meta tags
    const services = new Set();

    // Check navigation links
    $("nav a, header a").each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (
        text &&
        !text.match(/^(home|about|contact|blog|login|sign up|sign in)$/i)
      ) {
        if (text.length < 50) {
          // Reasonable service name length
          services.add($(el).text().trim());
        }
      }
    });

    // Check for services section
    $(
      '[class*="service"], [id*="service"], [class*="product"], [id*="product"]',
    ).each((_, el) => {
      const text = $(el).text().trim();
      const headings = $(el)
        .find("h2, h3, h4")
        .map((_, h) => $(h).text().trim())
        .get();
      headings.forEach((heading) => {
        if (heading.length < 50 && heading.length > 3) {
          services.add(heading);
        }
      });
    });

    metadata.services_list = Array.from(services).slice(0, 10); // Limit to 10 services

    // Extract value proposition from meta description or hero section
    const metaDesc = $('meta[name="description"]').attr("content")?.trim();
    const heroText = $(
      '[class*="hero"], [class*="banner"], [class*="headline"]',
    )
      .first()
      .text()
      .trim();

    metadata.value_proposition = metaDesc || heroText.substring(0, 200) || "";

    // Extract "does not" list - this is harder to extract automatically
    // We'll leave it empty for now, can be manually filled or enhanced later
    metadata.does_not_list = [];

    // Detect website language from HTML signals and body text
    const langInfo = detectWebsiteLanguage($, bodyText.trim());
    metadata.primary_language = langInfo.primary_language;
    metadata.languages = langInfo.languages;
    metadata.language_confidence = langInfo.language_confidence;
    metadata.language_source = langInfo.language_source;
  } catch (error) {
    console.error("Error extracting website metadata:", error);
  }

  return metadata;
};

const processWebPage = async (
  url,
  sourceCode,
  chromeCache = {},
  usageContext = {},
) => {
  try {
    const {
      userId = null,
      agentId = null,
      conversationId = null,
    } = usageContext;

    // Phase 3: typed extraction (rules → optional LLM → product/readability/generic)
    const extracted = await extractByPageType(
      url,
      sourceCode,
      chromeCache,
      { userId, agentId, conversationId },
    );
    const {
      content: cleanContent,
      webPageURL,
      title,
      metaDescription,
      canonicalUrl,
      language,
      pageMetadata,
      pageType,
      entity_type,
      entity_name,
      attributes,
      search_terms,
      classification_confidence,
      classification_reason,
      extraction_source,
    } = extracted;

    const isHomepage = isHomepageUrl(webPageURL);

    // Site-level WebsiteData classification (unchanged)
    const $meta = cheerio.load(sourceCode);
    let websiteMetadata = extractWebsiteMetadata($meta, url, { isHomepage });

    if (websiteMetadata?._needsLlamaTypeClassification) {
      // The LLM classifier sends up to ~48k chars of page content and is
      // token-expensive. Website type is stored once per site (homepage wins),
      // so only run the fallback on the homepage. Non-homepage pages keep the
      // local keyword/schema best-guess and never trigger a paid call.
      if (isHomepage) {
        const llamaType = await classifyWebsiteType({
          url,
          title,
          description: metaDescription,
          pageContent: cleanContent,
          schemaTypes: websiteMetadata._schemaTypes || [],
          userId,
          agentId,
          conversationId,
        });

        if (llamaType?.company_type) {
          websiteMetadata.company_type = llamaType.company_type;
          websiteMetadata.company_type_source = llamaType.source;
          if (llamaType.industry && !websiteMetadata.industry) {
            websiteMetadata.industry = llamaType.industry;
          }
        }
      }

      delete websiteMetadata._needsLlamaTypeClassification;
      delete websiteMetadata._schemaTypes;
    }

    if (isHomepage) {
      websiteMetadata._isHomepage = true;
    }

    return {
      content: cleanContent,
      webPageURL,
      title,
      metaDescription,
      canonicalUrl,
      language,
      pageMetadata,
      websiteMetadata,
      pageType: pageType || "generic",
      entity_type: entity_type || "general",
      entity_name: entity_name || null,
      attributes: attributes || {},
      search_terms: search_terms || [],
      classification_confidence:
        typeof classification_confidence === "number"
          ? classification_confidence
          : 0,
      classification_reason: classification_reason || "rules",
      extraction_source: extraction_source || "generic",
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
  },
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
    const {
      urls,
      userId,
      agentId,
      qdrantIndexName,
      plan,
      sitemapUrl,
      startTime,
      totalUrls,
    } = job.data;
    const trainingRunId = String(job.id);
    const runStartedAt = startTime ? new Date(startTime) : new Date();
    let batchResult = null;
    let trainFailed = false;
    let failedReason = null;
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
      const chromeCache = {};
      let metadataExtracted = false; // Track if metadata has been extracted
      let metadataFromHomepage = false;
      let stoppedForStorageLimit = false;
      let storageLimitEmitMessage = null;
      let storageLimitEmitProgress = null;
      /** Phase 2: in-batch canonical keys to avoid embedding URL variants of the same page */
      const seenCanonicalKeys = new Set();

      const scrapingStartTime = runStartedAt;
      const totalUrlsCount = totalUrls || urls.length;
      let lastProgressEmitTime = Date.now();
      const PROGRESS_EMIT_INTERVAL = 2000; // Emit progress every 2 seconds

      const emitScrapingProgress = async (
        currentIndex,
        totalCount,
        isProcessing = true,
      ) => {
        const scrapingProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "scraping",
          processed: currentIndex,
          total: totalCount,
          isProcessing,
        });

        await job.updateProgress({
          phase: "scraping",
          scrapeCurrent: currentIndex,
          scrapeTotal: totalCount,
        });

        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress,
        });
      };

      let lastTrainingEmitTime = 0;
      let trainingStartTime = null;
      let lastTrainingFraction = 0;
      const emitTrainingProgress = async ({
        trainingProcessed,
        trainingTotal,
        trainingFraction,
        embeddingProgress = 0,
        embeddingTotal = 0,
        upsertProgress = 0,
        upsertTotal = 0,
        trainingStep = "chunking",
        force = false,
      }) => {
        const now = Date.now();
        if (!force && now - lastTrainingEmitTime < PROGRESS_EMIT_INTERVAL) {
          return;
        }
        if (!trainingStartTime) trainingStartTime = new Date(now);
        lastTrainingEmitTime = now;

        const aggregateFraction = Number.isFinite(trainingFraction)
          ? Math.max(
              lastTrainingFraction,
              Math.max(0, Math.min(1, trainingFraction)),
            )
          : undefined;
        if (Number.isFinite(aggregateFraction)) {
          lastTrainingFraction = aggregateFraction;
        }

        const scrapingProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          trainingStartTime,
          phase: "training",
          processed: totalUrlsCount,
          total: totalUrlsCount,
          trainingFraction: aggregateFraction,
          trainingStep,
          trainingProcessed,
          trainingTotal,
          embeddingProgress,
          embeddingTotal,
          upsertProgress,
          upsertTotal,
          isProcessing: true,
        });

        await job.updateProgress({
          phase: "training",
          scrapeCurrent: totalUrlsCount,
          scrapeTotal: totalUrlsCount,
          trainingCurrent: trainingProcessed,
          trainingTotal,
          ...(Number.isFinite(aggregateFraction)
            ? { trainingFraction: aggregateFraction }
            : {}),
          trainingStep,
          embeddingProgress,
          embeddingTotal,
          upsertProgress,
          upsertTotal,
        });

        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress,
        });
      };

      // Emit initial progress
      await emitScrapingProgress(0, totalUrlsCount, true);
      await markUrlsQueued(urls, agentId);

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          if (!isScrapableWebUrl(url) || isNonContentPath(url)) {
            const reason = isNonContentPath(url)
              ? "Non-content URL skipped (cart/checkout/login/pagination)."
              : NON_HTML_SKIP_ERROR;
            console.log(`Skipping non-content URL: ${url}`);
            if (isNonContentPath(url)) {
              await markUrlSkipped(url, agentId, reason);
            } else {
              await markWebUrlScrapeFailed({
                url,
                userId,
                agentId,
                TrainingModel,
                error: reason,
              });
            }
            continue;
          }

          // Emit progress updates periodically (every 2 seconds or every URL)
          const now = Date.now();
          if (
            now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
            i === 0 ||
            i === urls.length - 1
          ) {
            await emitScrapingProgress(i + 1, totalUrlsCount, true);
            lastProgressEmitTime = now;
          }

          const { rawHtml: sourceCode } = await webScraper.scrapeWebpage(url, {
            maxRetries: 2,
            userId,
            jobId: job.id,
          });
          await markUrlFetched(url, agentId);

          const processResult = await processWebPage(
            url,
            sourceCode,
            chromeCache,
            { userId, agentId, conversationId: null },
          );
          if (!processResult?.content) {
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
            await markUrlFailed(
              url,
              agentId,
              "Failed to process/minify web page content",
            );
            continue;
          }

          const {
            content,
            title,
            metaDescription,
            webPageURL,
            websiteMetadata,
            canonicalUrl,
            language,
            pageType,
            entity_type,
            entity_name,
            attributes,
            search_terms,
            classification_confidence,
            classification_reason,
            extraction_source,
          } = processResult;

          // Phase 2: skip if this page's canonical is already covered by another URL
          const canonCheck = await checkCanonicalDuplicate({
            agentId,
            pageUrl: url,
            canonicalUrl,
            seenCanonicalKeys,
          });
          if (canonCheck.isDuplicate) {
            console.log(
              `[jobService] Skipping canonical duplicate ${url} → ${canonCheck.duplicateOf} (${canonCheck.reason})`,
            );
            await markUrlSkipped(
              url,
              agentId,
              `canonical_duplicate:${canonCheck.reason}`,
              {
                canonicalUrl: canonicalUrl || null,
                language: language || "en",
                pageType: pageType || "generic",
              },
            );
            continue;
          }

          // Store website metadata if extracted
          // Priority: homepage always wins; otherwise use first URL (domain-based name)
          if (websiteMetadata) {
            const isHome = websiteMetadata._isHomepage === true;
            const shouldStore =
              isHome || (!metadataExtracted && !metadataFromHomepage);

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
                metadataExtracted = true;
                if (isHome) metadataFromHomepage = true;
                console.log(
                  `[jobService] Stored website metadata for user ${userId} from ${url}`,
                );
              } catch (metadataError) {
                console.error(
                  `[jobService] Error storing website metadata:`,
                  metadataError,
                );
                // Don't fail the job if metadata storage fails
              }
            }
          }

          const contentSize = Buffer.byteLength(content, "utf8");

          let clientDoc = await Client.findOne({ userId });
          currentDataSize = clientDoc?.currentDataSize || 0;
          const maxStorage =
            clientDoc.customLimits?.isCustomLimits &&
            clientDoc.customLimits?.maxStorage != null
              ? clientDoc.customLimits.maxStorage
              : plan.limits.maxStorage;

          console.log("clientDoc", clientDoc);

          console.log("max storage is", maxStorage);
          console.log(
            "current data size + content size ",
            currentDataSize + contentSize,
          );
          // if (currentDataSize + contentSize > plan.limits.maxStorage) {
          if (currentDataSize + contentSize > maxStorage) {


            console.log("storage limit exceeded");
            await Client.updateOne(
              { userId },
              { $set: { "upgradePlanStatus.storageLimitExceeded": true } },
            );

            // Emit progress before stopping due to storage limit
            const storageLimitElapsedTime = Math.floor(
              (Date.now() - scrapingStartTime.getTime()) / 1000,
            );
            const formatTimeForLimit = (seconds) => {
              const hrs = Math.floor(seconds / 3600);
              const mins = Math.floor((seconds % 3600) / 60);
              const secs = seconds % 60;
              return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
            };

            storageLimitEmitMessage =
              "Storage limit exceeded. Scraping stopped. Upgrade your plan to continue.";
            storageLimitEmitProgress = {
              percentage:
                totalUrlsCount > 0
                  ? Math.round(((i + 1) / totalUrlsCount) * 100)
                  : 0,
              processed: i + 1,
              total: totalUrlsCount,
              elapsedTime: formatTimeForLimit(storageLimitElapsedTime),
              elapsedSeconds: storageLimitElapsedTime,
              estimatedTimeRemaining: null,
              estimatedSecondsRemaining: null,
              isProcessing: false,
              stoppedReason: "storage_limit_exceeded",
            };
            stoppedForStorageLimit = true;

            appEvents.emit("userEvent", agentId, "training-event", {
              agent: await Agent.findOne({ _id: agentId }),
              client: await Client.findOne({ userId }),
              message: storageLimitEmitMessage,
              scrapingProgress: storageLimitEmitProgress,
            });
            break;
          } else {
            await Client.updateOne(
              { userId },
              { $inc: { currentDataSize: contentSize } },
            );

            scrapedDocs.push({
              type: 0,
              content,
              dataSize: contentSize,
              metadata: {
                url: webPageURL,
                title,
                metaDescription,
                canonicalUrl: canonicalUrl || null,
                language: language || "en",
                pageType: pageType || "generic",
                entity_type: entity_type || "general",
                entity_name: entity_name || null,
                attributes: attributes || {},
                search_terms: search_terms || [],
                classification_confidence:
                  typeof classification_confidence === "number"
                    ? classification_confidence
                    : 0,
                classification_reason: classification_reason || "rules",
                extraction_source: extraction_source || "generic",
                type: "webpage",
              },
              originalUrl: url,
            });
          }
        } catch (error) {
          // Upsert so every scrape failure appears in the training list (find-only updates missed new URLs).
          const existingFailRow = await TrainingModel.findOne({
            userId,
            agentId,
            "webPage.url": url,
          })
            .select("trainingStatus")
            .lean();
          const prevTrainStatus = existingFailRow?.trainingStatus;

          await TrainingModel.findOneAndUpdate(
            { userId, agentId, "webPage.url": url },
            {
              $set: {
                userId,
                agentId,
                type: 0,
                trainingStatus: 2,
                lastEdit: Date.now(),
                error: error?.message,
                "webPage.url": url,
              },
            },
            { upsert: true, setDefaultsOnInsert: true }
          );

          if (prevTrainStatus !== 2) {
            const inc =
              prevTrainStatus === 1
                ? { "pagesAdded.success": -1, "pagesAdded.failed": 1 }
                : { "pagesAdded.failed": 1 };
            await Agent.updateOne({ _id: agentId }, { $inc: inc });
          }
          await markUrlFailed(url, agentId, error?.message || "Failed to train");
        }
      }

      if (!stoppedForStorageLimit) {
        await emitScrapingProgress(urls.length, totalUrlsCount, true);

        if (scrapedDocs.length > 0) {
          await emitTrainingProgress({
            trainingProcessed: 0,
            trainingTotal: scrapedDocs.length,
            force: true,
          });
        }
      }

      //make this a queue
      batchResult = await batchService.processDocumentAndTrain(
        scrapedDocs,
        userId,
        agentId,
        qdrantIndexName,
        {
          onProgress: async (progress) => {
            if (stoppedForStorageLimit) return;
            await emitTrainingProgress({
              trainingProcessed: progress.trainingProcessed,
              trainingTotal: progress.trainingTotal,
              trainingFraction: progress.trainingFraction,
              embeddingProgress: progress.embeddingProgress ?? 0,
              embeddingTotal: progress.embeddingTotal ?? 0,
              upsertProgress: progress.upsertProgress ?? 0,
              upsertTotal: progress.upsertTotal ?? 0,
              trainingStep: progress.step ?? "chunking",
              // Per-URL embedding/upsert callbacks are aggregated and throttled
              // so the frontend receives a smooth batch-level progression.
              force: false,
            });
          },
        },
      );

      // Handle training failure
      if (!batchResult.success) {
        // Mark all documents as failed if training failed
        await Agent.updateOne(
          { _id: agentId },
          { $set: { dataTrainingStatus: 0 } },
        );
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: error?.message,
        });
      } else {
        // 3️⃣ Update training status in DB
        for (const doc of scrapedDocs) {
          const pageResult = batchResult?.resultsByUrl?.[doc.originalUrl];
          const skipped = pageResult?.skipped;
          const failed = batchResult?.failedUrls?.includes(doc.originalUrl);

          if (skipped === "unchanged") {
            await markUrlUnchanged(doc.originalUrl, agentId, {
              contentHash: pageResult.contentHash,
              pageType: pageResult.page?.pageType || "generic",
              canonicalUrl: doc.metadata?.canonicalUrl || null,
              language: doc.metadata?.language || "en",
              qualityScore: pageResult.qualityScore,
            });
            // Already trained content — count as success for agent stats only if never counted
            continue;
          }

          if (skipped === "low_quality") {
            await markUrlSkipped(
              doc.originalUrl,
              agentId,
              `low_quality:${pageResult.skipReason || "below_threshold"}`,
              {
                canonicalUrl: doc.metadata?.canonicalUrl || null,
                language: doc.metadata?.language || "en",
                qualityScore: pageResult.qualityScore,
                contentHash: pageResult.contentHash,
                pageType: "generic",
              },
            );
            // Content was counted toward storage but never embedded — refund
            if (doc.dataSize > 0) {
              await Client.updateOne(
                { userId },
                { $inc: { currentDataSize: -doc.dataSize } },
              );
            }
            continue;
          }

          const status = failed ? 2 : 1;
          if (status == 1) {
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: doc.content,
              dataSize: doc.dataSize,
              trainingStatus: status,
              "webPage.url": doc.originalUrl,
              chunkCount: batchResult.chunkCountPerUrl?.[doc.originalUrl] || 0,
              lastEdit: Date.now(),
            });
            await markUrlProcessed(doc.originalUrl, agentId, {
              contentHash:
                pageResult?.contentHash || pageResult?.page?.content_hash,
              pageType:
                pageResult?.page?.pageType ||
                doc.metadata?.pageType ||
                "generic",
              canonicalUrl: doc.metadata?.canonicalUrl || null,
              language: doc.metadata?.language || "en",
              qualityScore: pageResult?.qualityScore,
            });
          } else if (status == 2) {
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: doc.content,
              dataSize: doc.dataSize,
              trainingStatus: status,
              error: "Failed to process/minify web page content",
              "webPage.url": doc.originalUrl,
              chunkCount: batchResult.chunkCountPerUrl?.[doc.originalUrl] || 0,
              lastEdit: Date.now(),
            });
            await markUrlFailed(
              doc.originalUrl,
              agentId,
              "Failed to process/minify web page content",
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
            },
          );
        }

        if (sitemapUrl) {
          await Agent.updateOne(
            { _id: agentId },
            { $set: { isSitemapAdded: 1 } },
          );
        }
      }

      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 0,
            scrapingStartTime: null,
            lastTrained: new Date(),
          },
        },
      );

      if (stoppedForStorageLimit && storageLimitEmitProgress) {
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          client: await Client.findOne({ userId }),
          message: storageLimitEmitMessage,
          scrapingProgress: storageLimitEmitProgress,
        });
      } else {
        const trainTotal = scrapedDocs.length || totalUrlsCount;
        const finalProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "training",
          processed: totalUrlsCount,
          total: totalUrlsCount,
          trainingStep: "upserting",
          trainingProcessed: trainTotal,
          trainingTotal: trainTotal,
          embeddingProgress: trainTotal,
          embeddingTotal: trainTotal,
          upsertProgress: trainTotal,
          upsertTotal: trainTotal,
          isProcessing: false,
        });
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress: finalProgress,
        });
      }
    } catch (error) {
      trainFailed = true;
      failedReason = error?.message || "Training job threw an error";
      await Agent.updateOne(
        { _id: agentId },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );

      // Calculate progress even on error
      const errorElapsedTime = Math.floor(
        (Date.now() - runStartedAt.getTime()) / 1000,
      );
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      };

      // Try to get current progress from URL count
      const processedCount = await Url.countDocuments({
        userId,
        agentId: agentId,
        trainStatus: { $in: [1, 2] },
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
        scrapingProgress: {
          percentage:
            totalUrlsCount > 0
              ? Math.round((processedCount / totalUrlsCount) * 100)
              : 0,
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
    } finally {
      const status =
        trainFailed || batchResult?.success === false ? "failed" : "completed";
      await saveTrainingObserve({
        trainingRunId,
        userId,
        agentId,
        status,
        startedAt: runStartedAt,
        totalChunks: batchResult?.totalChunks ?? 0,
        failedReason:
          status === "failed"
            ? failedReason ||
              batchResult?.error ||
              (batchResult?.failedUrls?.length
                ? `Failed URLs: ${batchResult.failedUrls.length}`
                : null)
            : null,
      });
    }
  },
  { connection: redisConfig, concurrency: 3 },
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
    const { entries, userId, agentId, qdrantIndexName, TrainingModelName } =
      job.data;
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
      const qdrantResult =
        await QdrantVectorStoreManager.deleteVectorsByTrainingEntries(
          qdrantIndexName,
          entries.map((e) => ({
            userId: e.userId?.toString(),
            agentId: e.agentId?.toString(),
            type: e.type,
            url: e.webPage?.url,
            title: e.title,
          })),
        );

      if (qdrantResult.errors?.length > 0) {
        console.warn(
          "[deleteTrainingData] Qdrant delete warnings:",
          qdrantResult.errors,
        );
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
      if (pagesSuccessDeleted > 0)
        updateFields["pagesAdded.success"] = -pagesSuccessDeleted;
      if (pagesFailedDeleted > 0)
        updateFields["pagesAdded.failed"] = -pagesFailedDeleted;
      if (pagesSuccessDeleted > 0 || pagesFailedDeleted > 0) {
        updateFields["pagesAdded.total"] = -(
          pagesSuccessDeleted + pagesFailedDeleted
        );
      }
      if (filesDeleted > 0) updateFields.filesAdded = -filesDeleted;
      if (faqsDeleted > 0) updateFields.faqsAdded = -faqsDeleted;
      if (Object.keys(updateFields).length > 0) {
        await Agent.updateOne({ _id: agentId }, { $inc: updateFields });
      }

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      console.log(
        `[deleteTrainingData] Deleted ${entries.length} training entries for user ${userId}`,
      );
    } catch (error) {
      console.error("[deleteTrainingData] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
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
    const {
      entries,
      userId,
      agentId,
      qdrantIndexName,
      TrainingModelName,
      startTime,
      totalEntries: jobTotalEntries,
    } = job.data;
    const trainingRunId = String(job.id);
    const runStartedAt = startTime ? new Date(startTime) : new Date();
    let batchResult = null;
    let trainFailed = false;
    let failedReason = null;
    const batchService = new batchTrainingService();
    const Agent = require("../models/Agent");

    const TrainingModel =
      TrainingModelName === "TrainingListFreeUsers"
        ? require("../models/TrainingListFreeUsers")
        : require("../models/OpenaiTrainingList");

    const retrainStartTime = runStartedAt;
    const validEntries = (entries || []).filter((e) => e.webPage?.url);
    const totalEntries = jobTotalEntries || validEntries.length;
    let lastProgressEmitTime = Date.now();
    const PROGRESS_EMIT_INTERVAL = 2000;
    let lastTrainingEmitTime = 0;
    let trainingStartTime = null;
    let lastTrainingFraction = 0;
    let processedCount = 0;

    const emitScrapingProgress = async (
      currentIndex,
      totalCount,
      isProcessing = true,
    ) => {
      const scrapingProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        phase: "scraping",
        processed: currentIndex,
        total: totalCount,
        isProcessing,
      });

      await job.updateProgress({
        phase: "scraping",
        scrapeCurrent: currentIndex,
        scrapeTotal: totalCount,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress,
      });
    };

    const emitTrainingProgress = async ({
      trainingProcessed,
      trainingTotal,
      trainingFraction,
      embeddingProgress = 0,
      embeddingTotal = 0,
      upsertProgress = 0,
      upsertTotal = 0,
      trainingStep = "chunking",
      force = false,
    }) => {
      const now = Date.now();
      if (!force && now - lastTrainingEmitTime < PROGRESS_EMIT_INTERVAL) {
        return;
      }
      if (!trainingStartTime) trainingStartTime = new Date(now);
      lastTrainingEmitTime = now;

      const aggregateFraction = Number.isFinite(trainingFraction)
        ? Math.max(
            lastTrainingFraction,
            Math.max(0, Math.min(1, trainingFraction)),
          )
        : undefined;
      if (Number.isFinite(aggregateFraction)) {
        lastTrainingFraction = aggregateFraction;
      }

      const scrapingProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        trainingStartTime,
        phase: "training",
        processed: totalEntries,
        total: totalEntries,
        trainingFraction: aggregateFraction,
        trainingStep,
        trainingProcessed,
        trainingTotal,
        embeddingProgress,
        embeddingTotal,
        upsertProgress,
        upsertTotal,
        isProcessing: true,
      });

      await job.updateProgress({
        phase: "training",
        scrapeCurrent: totalEntries,
        scrapeTotal: totalEntries,
        trainingCurrent: trainingProcessed,
        trainingTotal,
        ...(Number.isFinite(aggregateFraction)
          ? { trainingFraction: aggregateFraction }
          : {}),
        trainingStep,
        embeddingProgress,
        embeddingTotal,
        upsertProgress,
        upsertTotal,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress,
      });
    };

    try {
      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 1,
            scrapingStartTime: retrainStartTime,
          },
        },
      );
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      const chromeCache = {};
      const pendingRetrainItems = [];
      const retrainCanonicalKeys = new Set();
      const qdrantManager = new QdrantVectorStoreManager(qdrantIndexName);
      let successCount = 0;
      let failCount = 0;

      async function applyWebPagePagesAddedDelta(prevStatus, newStatus) {
        if (prevStatus === newStatus) return;
        const inc = {};
        if (prevStatus === 1) inc["pagesAdded.success"] = -1;
        else if (prevStatus === 2) inc["pagesAdded.failed"] = -1;
        if (newStatus === 1) inc["pagesAdded.success"] = (inc["pagesAdded.success"] || 0) + 1;
        else if (newStatus === 2) inc["pagesAdded.failed"] = (inc["pagesAdded.failed"] || 0) + 1;
        const filtered = Object.fromEntries(Object.entries(inc).filter(([, v]) => v !== 0));
        if (Object.keys(filtered).length === 0) return;
        await Agent.updateOne({ _id: agentId }, { $inc: filtered });
      }

      const markEntryFailed = async ({ entry, prevStatus, error }) => {
        await TrainingModel.updateOne(
          { _id: entry._id },
          {
            $set: {
              trainingStatus: 2,
              error,
              lastEdit: new Date(),
            },
          },
        );
        await applyWebPagePagesAddedDelta(prevStatus, 2);
        failCount++;
      };

      const markEntryFailedAndContinue = async (args) => {
        await markEntryFailed(args);
        processedCount++;
        await emitScrapingProgress(
          processedCount,
          totalEntries,
          processedCount < totalEntries,
        );
      };

      await emitScrapingProgress(0, totalEntries, true);

      for (let i = 0; i < validEntries.length; i++) {
        const entry = validEntries[i];
        const url = entry.webPage.url;
        const prevStatus = entry.trainingStatus;

        const now = Date.now();
        if (
          now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
          i === 0 ||
          i === validEntries.length - 1
        ) {
          await emitScrapingProgress(processedCount, totalEntries, true);
          lastProgressEmitTime = now;
        }

        try {
          if (!isScrapableWebUrl(url) || isNonContentPath(url)) {
            console.log(`[retrainTrainingData] Skipping non-content URL: ${url}`);
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: isNonContentPath(url)
                ? "Non-content URL skipped (cart/checkout/login/pagination)."
                : NON_HTML_SKIP_ERROR,
            });
            continue;
          }

          const { rawHtml } = await webScraper.scrapeWebpage(url, {
            maxRetries: 2,
            userId,
            jobId: job.id,
          });

          const processResult = await processWebPage(
            url,
            rawHtml,
            chromeCache,
            { userId, agentId, conversationId: null },
          );

          if (!processResult?.content) {
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: "Failed to process/minify web page content",
            });
            continue;
          }

          const {
            content,
            title,
            metaDescription,
            webPageURL,
            canonicalUrl,
            language,
            pageType,
            entity_type,
            entity_name,
            attributes,
            search_terms,
            classification_confidence,
            classification_reason,
            extraction_source,
          } = processResult;

          // Phase 2: canonical duplicate — leave existing vectors of the canonical page
          const canonCheck = await checkCanonicalDuplicate({
            agentId,
            pageUrl: url,
            canonicalUrl,
            seenCanonicalKeys: retrainCanonicalKeys,
          });
          if (canonCheck.isDuplicate) {
            await markUrlSkipped(
              url,
              agentId,
              `canonical_duplicate:${canonCheck.reason}`,
              {
                canonicalUrl: canonicalUrl || null,
                language: language || "en",
                pageType: pageType || "generic",
              },
            );
            processedCount++;
            await emitScrapingProgress(
              processedCount,
              totalEntries,
              processedCount < totalEntries,
            );
            continue;
          }

          const contentSize = Buffer.byteLength(content, "utf8");
          const oldDataSize = entry.dataSize || 0;
          const dataSizeDelta = contentSize - oldDataSize;

          pendingRetrainItems.push({
            entry,
            prevStatus,
            url,
            content,
            contentSize,
            dataSizeDelta,
            scrapedDoc: {
              type: 0,
              content,
              dataSize: contentSize,
              metadata: {
                url: webPageURL,
                title,
                metaDescription,
                canonicalUrl: canonicalUrl || null,
                language: language || "en",
                pageType: pageType || "generic",
                entity_type: entity_type || "general",
                entity_name: entity_name || null,
                attributes: attributes || {},
                search_terms: search_terms || [],
                classification_confidence:
                  typeof classification_confidence === "number"
                    ? classification_confidence
                    : 0,
                classification_reason: classification_reason || "rules",
                extraction_source: extraction_source || "generic",
                type: "webpage",
              },
              originalUrl: url,
            },
          });

          processedCount++;
          await emitScrapingProgress(
            processedCount,
            totalEntries,
            processedCount < totalEntries,
          );
        } catch (err) {
          console.error(`[retrainTrainingData] Error retraining ${url}:`, err);
          await markEntryFailedAndContinue({
            entry,
            prevStatus,
            error: err?.message || "Scraping failed",
          });
        }
      }

      if (pendingRetrainItems.length > 0) {
        await emitTrainingProgress({
          trainingProcessed: 0,
          trainingTotal: pendingRetrainItems.length,
          force: true,
        });

        batchResult = await batchService.processDocumentAndTrain(
          pendingRetrainItems.map((item) => item.scrapedDoc),
          userId,
          agentId,
          qdrantIndexName,
          {
            onProgress: async (progress) => {
              await emitTrainingProgress({
                trainingProcessed: progress.trainingProcessed ?? 0,
                trainingTotal:
                  progress.trainingTotal ?? pendingRetrainItems.length,
                trainingFraction: progress.trainingFraction,
                embeddingProgress: progress.embeddingProgress ?? 0,
                embeddingTotal: progress.embeddingTotal ?? 0,
                upsertProgress: progress.upsertProgress ?? 0,
                upsertTotal: progress.upsertTotal ?? 0,
                trainingStep: progress.step ?? "chunking",
                force: false,
              });
            },
          },
        );

        if (!batchResult.success) {
          for (const item of pendingRetrainItems) {
            await markEntryFailed({
              entry: item.entry,
              prevStatus: item.prevStatus,
              error: batchResult.error || "Failed to upsert vectors",
            });
          }
        } else {
          for (const item of pendingRetrainItems) {
            const pageResult = batchResult?.resultsByUrl?.[item.url];
            const skipped = pageResult?.skipped;
            const failed = batchResult.failedUrls?.includes(item.url);

            if (skipped === "unchanged") {
              await markUrlUnchanged(item.url, agentId, {
                contentHash: pageResult.contentHash,
                pageType: pageResult.page?.pageType || "generic",
                canonicalUrl: item.scrapedDoc?.metadata?.canonicalUrl || null,
                language: item.scrapedDoc?.metadata?.language || "en",
                qualityScore: pageResult.qualityScore,
              });
              successCount++;
              continue;
            }

            if (skipped === "low_quality") {
              await markUrlSkipped(
                item.url,
                agentId,
                `low_quality:${pageResult.skipReason || "below_threshold"}`,
                {
                  canonicalUrl: item.scrapedDoc?.metadata?.canonicalUrl || null,
                  language: item.scrapedDoc?.metadata?.language || "en",
                  qualityScore: pageResult.qualityScore,
                  contentHash: pageResult.contentHash,
                },
              );
              // Remove stale vectors if quality now fails after prior success
              try {
                await qdrantManager.deleteByFields({
                  user_id: userId?.toString(),
                  agent_id: agentId?.toString(),
                  url: item.url,
                });
              } catch (delErr) {
                console.warn(
                  `[retrain] low_quality delete warning for ${item.url}:`,
                  delErr.message,
                );
              }
              continue;
            }

            if (failed) {
              await markEntryFailed({
                entry: item.entry,
                prevStatus: item.prevStatus,
                error: "Failed to upsert vectors",
              });
              continue;
            }

            await TrainingModel.updateOne(
              { _id: item.entry._id },
              {
                $set: {
                  content: item.content,
                  dataSize: item.contentSize,
                  trainingStatus: 1,
                  lastEdit: new Date(),
                  chunkCount: batchResult.chunkCountPerUrl?.[item.url] || 0,
                  "webPage.url": item.url,
                },
              },
            );

            await markUrlProcessed(item.url, agentId, {
              contentHash:
                pageResult?.contentHash || pageResult?.page?.content_hash,
              pageType: pageResult?.page?.pageType || "generic",
              canonicalUrl: item.scrapedDoc?.metadata?.canonicalUrl || null,
              language: item.scrapedDoc?.metadata?.language || "en",
              qualityScore: pageResult?.qualityScore,
            });

            await applyWebPagePagesAddedDelta(item.prevStatus, 1);

            if (item.dataSizeDelta !== 0) {
              await Client.updateOne(
                { userId },
                { $inc: { currentDataSize: item.dataSizeDelta } },
              );
            }

            successCount++;
          }
        }
      }

      await emitScrapingProgress(totalEntries, totalEntries, false);

      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 0,
            scrapingStartTime: null,
            lastTrained: new Date(),
          },
        },
      );

      const finalProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        phase: "training",
        processed: totalEntries,
        total: totalEntries,
        trainingStep: "upserting",
        trainingProcessed: totalEntries,
        trainingTotal: totalEntries,
        embeddingProgress: totalEntries,
        embeddingTotal: totalEntries,
        upsertProgress: totalEntries,
        upsertTotal: totalEntries,
        isProcessing: false,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress: finalProgress,
      });

      console.log(
        `[retrainTrainingData] Completed: ${successCount} success, ${failCount} failed for user ${userId}`,
      );
    } catch (error) {
      trainFailed = true;
      failedReason = error?.message || "Retrain job threw an error";
      console.error("[retrainTrainingData] Job failed:", error);
      await Agent.updateOne(
        { _id: agentId },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
      });
      throw error;
    } finally {
      const status =
        trainFailed || batchResult?.success === false ? "failed" : "completed";
      await saveTrainingObserve({
        trainingRunId,
        userId,
        agentId,
        status,
        startedAt: runStartedAt,
        totalChunks: batchResult?.totalChunks ?? 0,
        failedReason:
          status === "failed"
            ? failedReason ||
              batchResult?.error ||
              (batchResult?.failedUrls?.length
                ? `Failed URLs: ${batchResult.failedUrls.length}`
                : null)
            : null,
      });
    }
  },
  { connection: redisConfig, concurrency: 2 },
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
        console.warn(
          "[transcriptEmailQueue] Missing conversation data, skipping job",
        );
        return;
      }

      const {
        sendConversationTranscriptEmail,
      } = require("../helpers/visitorHandlers");
      await sendConversationTranscriptEmail(conversation);
      console.log(
        `[transcriptEmailQueue] Transcript email sent for conversation ${conversation._id}`,
      );
    } catch (error) {
      console.error("[transcriptEmailQueue] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
);

const contactUsEmailQueue = new Queue("contactUsEmailQueue", {
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
  "contactUsEmailQueue",
  async (job) => {
    const { name, email, phone, message, supportEmail, service, website } = job.data || {};
    try {
      if (!name || !email || !message || !supportEmail || !service || !website) {
        console.warn("[contactUsEmailQueue] Missing email payload, skipping job");
        return;
      }

      const { sendContactUsEmail } = require("./emailService");
      const emailSent = await sendContactUsEmail({
        name,
        email,
        phone,
        message,
        supportEmail,
        service,
        website,
      });

      if (!emailSent) {
        throw new Error("Failed to send contact us email");
      }

      console.log(
        `[contactUsEmailQueue] Contact email sent for ${email} to ${supportEmail}`,
      );
    } catch (error) {
      console.error("[contactUsEmailQueue] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
);

module.exports = {
  planUpgradeQueue,
  urlProcessingQueue,
  deleteTrainingDataQueue,
  retrainTrainingDataQueue,
  transcriptEmailQueue,
  contactUsEmailQueue,
};
