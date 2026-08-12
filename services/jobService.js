require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Agent = require("../models/Agent");
const Url = require("../models/Url.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const cheerio = require("cheerio");
const webScraper = require("./WebScraper.js");
const QdrantVectorStoreManager = require("./QdrantService");
const { buildTrainingProgressPayload } = require("../utils/trainingProgress.js");
const {
  isHomepageUrl,
} = require("../utils/webUrlUtils.js");
const {
  runParallelScrapeOverlapTrain,
  runParallelRetrainOverlap,
} = require("./parallelUrlTraining.js");
const { detectWebsiteLanguage } = require("../utils/websiteLanguage");
const {
  extractNavigationCategories,
} = require("../utils/navigationCategories");
const {
  classifyWebsiteType,
} = require("./LlamaWebsiteClassifierService");
const { websiteTypeDefinitions, industryKeywords } = require("../utils/jobService/data.js");
const {
  extractByPageType,
  markUrlFailed,
  markUrlsQueued,
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

  const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
  await recomputeWebPageCounters(TrainingModel, userId, agentId);

  await markUrlFailed(url, userId, agentId, error);
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
    categories_list: [],
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

    metadata.categories_list = extractNavigationCategories($, url);

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
      sections,
      product_id,
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

    console.log("[pageType:trace]", {
      stage: "processWebPage",
      url: webPageURL,
      pageType: pageType || "generic",
      entity_type: entity_type || "general",
      extraction_source: extraction_source || "generic",
      classification_reason: classification_reason || "rules",
      classification_confidence:
        typeof classification_confidence === "number"
          ? classification_confidence
          : 0,
      contentChars: String(cleanContent || "").length,
      contentWords: String(cleanContent || "")
        .split(/\s+/)
        .filter(Boolean).length,
      sectionCount: Array.isArray(sections) ? sections.length : 0,
    });

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
      product_id: product_id || null,
      sections: Array.isArray(sections) ? sections : undefined,
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

      let stoppedForStorageLimit = false;
      let storageLimitEmitMessage = null;
      let storageLimitEmitProgress = null;
      let scrapedDocs = [];

      // Use startTime from job data or current time as fallback
      const scrapingStartTime = startTime ? new Date(startTime) : new Date();
      const totalUrlsCount = totalUrls || urls.length;
      const PROGRESS_EMIT_INTERVAL = 2000;

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

        const scrapeProcessed = Math.min(
          Math.max(0, Number(trainingProcessed) || 0),
          totalUrlsCount,
        );

        const scrapingProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          trainingStartTime,
          phase: "training",
          processed: scrapeProcessed,
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

      await emitScrapingProgress(0, totalUrlsCount, true);
      await markUrlsQueued(urls, userId, agentId);

      const pipelineResult = await runParallelScrapeOverlapTrain({
        urls,
        userId,
        agentId,
        qdrantIndexName,
        plan,
        TrainingModel,
        batchService,
        processWebPage,
        webScraper,
        jobId: job.id,
        emitScrapingProgress,
        emitTrainingProgress,
        markWebUrlScrapeFailed,
        nonHtmlSkipError: NON_HTML_SKIP_ERROR,
        scrapingStartTime,
        totalUrlsCount,
        onStorageLimit: async ({ scrapeCompleted }) => {
          const storageLimitElapsedTime = Math.floor(
            (Date.now() - scrapingStartTime.getTime()) / 1000,
          );
          const formatTimeForLimit = (seconds) => {
            const hrs = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            return (
              String(hrs).padStart(2, "0") +
              ":" +
              String(mins).padStart(2, "0") +
              ":" +
              String(secs).padStart(2, "0")
            );
          };

          storageLimitEmitMessage =
            "Storage limit exceeded. Scraping stopped. Upgrade your plan to continue.";
          storageLimitEmitProgress = {
            percentage:
              totalUrlsCount > 0
                ? Math.round((scrapeCompleted / totalUrlsCount) * 100)
                : 0,
            processed: scrapeCompleted,
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
        },
      });

      scrapedDocs = pipelineResult.scrapedDocs || [];
      stoppedForStorageLimit =
        stoppedForStorageLimit || !!pipelineResult.stoppedForStorageLimit;

      if (pipelineResult.anyTrainFailed) {
        await Agent.updateOne(
          { _id: agentId },
          { $set: { dataTrainingStatus: 0 } },
        );
      }

      if (sitemapUrl && scrapedDocs.length > 0) {
        await Agent.updateOne(
          { _id: agentId },
          { $set: { isSitemapAdded: 1 } },
        );
      }

      // Final inventory alignment after all URLs finish (skips, scrapes, trains).
      const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
      await recomputeWebPageCounters(TrainingModel, userId, agentId);

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
          trainingSummary: pipelineResult.trainingSummary || null,
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
        const trainingSummary = pipelineResult.trainingSummary || null;
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress: finalProgress,
          trainingSummary,
        });
      }
    } catch (error) {
      await Agent.updateOne(
        { _id: agentId },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );

      // Calculate progress even on error
      const errorElapsedTime = Math.floor(
        (Date.now() - scrapingStartTime.getTime()) / 1000,
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
    const Agent = require("../models/Agent");
    const appEvents = require("../events");

    try {
      const TrainingModel =
        TrainingModelName === "TrainingListFreeUsers"
          ? require("../models/TrainingListFreeUsers")
          : require("../models/OpenaiTrainingList");

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

      const Url = require("../models/Url");
      const entryIds = entries.map((entry) => entry._id).filter(Boolean);
      const deletedPageUrls = [
        ...new Set(
          entries
            .filter((entry) => entry.type === 0)
            .map((entry) => entry.webPage?.url)
            .filter(Boolean),
        ),
      ];

      // deleteMany removes every selected/duplicate row in one pass. Re-running
      // this worker is safe because counters are recomputed below.
      const deleteResult = await TrainingModel.deleteMany({
        _id: { $in: entryIds },
        userId,
        agentId,
      });

      // Clear Url pipeline rows so re-add → re-train is not skipped as
      // "content unchanged" (stale contentHash) with no TrainingModel row.
      if (deletedPageUrls.length > 0) {
        const urlDeleteResult = await Url.deleteMany({
          userId,
          agentId,
          url: { $in: deletedPageUrls },
        });
        console.log(
          `[deleteTrainingData] Cleared ${urlDeleteResult.deletedCount || 0} Url pipeline row(s) for agent ${agentId}`,
        );
      }

      // Recompute counters from source-of-truth rows. This is idempotent on
      // BullMQ retries and repairs drift from older duplicate rows.
      const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
      await recomputeWebPageCounters(TrainingModel, userId, agentId);

      const filesTotal = await TrainingModel.countDocuments({
        userId,
        agentId,
        type: 1,
      });
      const faqsTotal = await TrainingModel.countDocuments({
        userId,
        agentId,
        type: 3,
      });
      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            filesAdded: filesTotal,
            faqsAdded: faqsTotal,
          },
        },
      );

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      console.log(
        `[deleteTrainingData] Deleted ${deleteResult.deletedCount || 0} training entries for user ${userId}`,
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
    const batchService = new batchTrainingService();
    const Agent = require("../models/Agent");

    const TrainingModel =
      TrainingModelName === "TrainingListFreeUsers"
        ? require("../models/TrainingListFreeUsers")
        : require("../models/OpenaiTrainingList");

    const retrainStartTime = startTime ? new Date(startTime) : new Date();
    const validEntries = (entries || []).filter((e) => e.webPage?.url);
    const totalEntries = jobTotalEntries || validEntries.length;
    const PROGRESS_EMIT_INTERVAL = 2000;
    let lastTrainingEmitTime = 0;
    let trainingStartTime = null;
    let lastTrainingFraction = 0;

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

      const qdrantManager = new QdrantVectorStoreManager(qdrantIndexName);

      await emitScrapingProgress(0, totalEntries, true);

      const retrainResult = await runParallelRetrainOverlap({
        validEntries,
        userId,
        agentId,
        qdrantIndexName,
        TrainingModel,
        batchService,
        processWebPage,
        webScraper,
        jobId: job.id,
        emitScrapingProgress,
        emitTrainingProgress,
        qdrantManager,
        nonHtmlSkipError: NON_HTML_SKIP_ERROR,
        totalEntries,
      });

      const successCount = retrainResult.successCount || 0;
      const failCount = retrainResult.failCount || 0;

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


// email job service Queue 

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
