/**
 * Parallel scrape (bounded concurrency) + overlap chunk/embed/Qdrant train.
 * Used by urlProcessingQueue and retrainTrainingDataQueue workers.
 */
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const WebsiteData = require("../models/WebsiteData");
const {
  ConcurrencyLimiter,
  createAsyncLock,
  mapWithConcurrency,
} = require("../utils/concurrency");
const {
  isScrapableWebUrl,
  isNonContentPath,
} = require("../utils/webUrlUtils");
const {
  buildNavigationDocument,
} = require("../utils/navigationCategories");
const {
  markUrlFetched,
  markUrlProcessed,
  markUrlFailed,
  markUrlSkipped,
  markUrlUnchanged,
  checkCanonicalDuplicate,
} = require("./contentPipeline");

const DEFAULT_SCRAPE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.TRAINING_SCRAPE_CONCURRENCY || "8", 10) || 8,
);
const DEFAULT_EMBED_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.TRAINING_EMBED_CONCURRENCY || "3", 10) || 3,
);

function createTrainingOutcomeSummary(total = 0) {
  return {
    total: Number(total) || 0,
    trained: 0,
    failed: 0,
    skipped: 0,
    unchanged: 0,
    skipReasons: {},
  };
}

function recordSkipReason(summary, reason) {
  const key = String(reason || "skipped").slice(0, 180);
  summary.skipReasons[key] = (summary.skipReasons[key] || 0) + 1;
}

function humanizeTrainingSkipReason(reason, duplicateOf = null) {
  const raw = String(reason || "skipped");
  if (raw.startsWith("canonical_duplicate:")) {
    const target = duplicateOf ? ` (${duplicateOf})` : "";
    return `Skipped: page already trained via canonical URL${target}`;
  }
  if (raw.startsWith("low_quality:")) {
    const detail = raw.slice("low_quality:".length);
    if (detail === "empty_input") {
      return "Skipped: page had no usable content";
    }
    return `Skipped: low-quality content (${detail})`;
  }
  if (/non-content/i.test(raw)) {
    return "Skipped: non-content URL (cart/checkout/login/pagination)";
  }
  if (/non-html/i.test(raw)) {
    return "Skipped: non-HTML URL";
  }
  return raw;
}

async function upsertSkippedTrainingRow({
  TrainingModel,
  userId,
  agentId,
  url,
  reason,
  title = null,
  duplicateOf = null,
}) {
  const error = humanizeTrainingSkipReason(reason, duplicateOf);
  const trainingFilter = {
    userId,
    agentId,
    type: 0,
    "webPage.url": url,
  };
  const existingRows = await TrainingModel.find(trainingFilter)
    .sort({ createdAt: 1 })
    .select("_id")
    .lean();

  const trainingUpdate = {
    userId,
    agentId,
    type: 0,
    title: title || url,
    content: "",
    dataSize: 0,
    trainingStatus: 2,
    error,
    "webPage.url": url,
    chunkCount: 0,
    lastEdit: Date.now(),
  };

  if (existingRows.length > 0) {
    await TrainingModel.updateOne(
      { _id: existingRows[0]._id },
      { $set: trainingUpdate },
    );
    if (existingRows.length > 1) {
      await TrainingModel.deleteMany({
        _id: { $in: existingRows.slice(1).map((row) => row._id) },
      });
    }
  } else {
    await TrainingModel.create(trainingUpdate);
  }

  const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
  await recomputeWebPageCounters(TrainingModel, userId, agentId);
  return error;
}

/**
 * @param {object} opts
 * @param {string[]} opts.urls
 * @param {string|object} opts.userId
 * @param {string|object} opts.agentId
 * @param {string} opts.qdrantIndexName
 * @param {object} opts.plan
 * @param {object} opts.TrainingModel
 * @param {object} opts.batchService
 * @param {Function} opts.processWebPage
 * @param {object} opts.webScraper
 * @param {string|number} opts.jobId
 * @param {Function} opts.emitScrapingProgress
 * @param {Function} opts.emitTrainingProgress
 * @param {Function} opts.markWebUrlScrapeFailed
 * @param {string} opts.nonHtmlSkipError
 * @param {number} [opts.scrapeConcurrency]
 * @param {number} [opts.embedConcurrency]
 * @param {Date} opts.scrapingStartTime
 * @param {number} opts.totalUrlsCount
 * @param {Function} [opts.onStorageLimit]
 */
async function runParallelScrapeOverlapTrain(opts) {
  const {
    urls,
    userId,
    agentId,
    qdrantIndexName,
    plan,
    TrainingModel,
    batchService,
    processWebPage,
    webScraper,
    jobId,
    emitScrapingProgress,
    emitTrainingProgress,
    markWebUrlScrapeFailed,
    nonHtmlSkipError,
    scrapeConcurrency = DEFAULT_SCRAPE_CONCURRENCY,
    embedConcurrency = DEFAULT_EMBED_CONCURRENCY,
    scrapingStartTime,
    totalUrlsCount,
    onStorageLimit,
  } = opts;

  const chromeCache = {};
  const seenCanonicalKeys = new Set();
  const withSharedLock = createAsyncLock();
  const trainLimiter = new ConcurrencyLimiter(embedConcurrency);
  const trainPromises = [];
  const scrapedDocs = [];

  let metadataExtracted = false;
  let metadataFromHomepage = false;
  let navigationDocQueued = false;
  let stoppedForStorageLimit = false;
  let scrapeCompleted = 0;
  let trainQueued = 0;
  let trainCompleted = 0;
  let anyTrainFailed = false;
  let lastProgressEmitTime = 0;
  const PROGRESS_EMIT_INTERVAL = 2000;
  const outcomeSummary = createTrainingOutcomeSummary(totalUrlsCount);

  console.log(
    `[parallelUrlTraining] scrape=${scrapeConcurrency} embed=${embedConcurrency} urls=${totalUrlsCount}`,
  );

  const summarizeDoc = (doc) =>
    `${doc.originalUrl} chunks=${doc.dataSize != null ? `bytes=${doc.dataSize}` : "bytes=?"}`;

  const computeOverlapFraction = () => {
    const scrapeFrac =
      totalUrlsCount > 0 ? scrapeCompleted / totalUrlsCount : 1;
    const trainFrac = trainQueued > 0 ? trainCompleted / trainQueued : 0;
    if (scrapeCompleted < totalUrlsCount) {
      return Math.max(0, Math.min(1, scrapeFrac * 0.45 + trainFrac * 0.55));
    }
    return Math.max(0, Math.min(1, trainFrac));
  };

  const bumpScrapeProgress = async () => {
    scrapeCompleted += 1;
    const now = Date.now();
    if (
      now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
      scrapeCompleted === 1 ||
      scrapeCompleted >= totalUrlsCount
    ) {
      await emitScrapingProgress(
        scrapeCompleted,
        totalUrlsCount,
        scrapeCompleted < totalUrlsCount || trainQueued > trainCompleted,
      );
      lastProgressEmitTime = now;
    }
  };

  const finalizeTrainedDoc = async (doc, result) => {
    // Synthetic navigation vectors support PAGE_LINKS retrieval but are not
    // crawled pages — skip TrainingList / Url lifecycle updates.
    if (doc.metadata?.synthetic_navigation) {
      console.log(
        `[parallelUrlTraining] synthetic navigation trained url=${doc.originalUrl}`,
      );
      return;
    }

    const pageResult = result?.resultsByUrl?.[doc.originalUrl];
    const skipped = pageResult?.skipped;
    const trainError =
      pageResult?.error ||
      result?.error ||
      "Failed to process/minify web page content";
    // Prefer per-URL outcome; batch success is secondary so one bad page
    // in a multi-doc batch does not mislabel a successful page.
    const failed =
      pageResult?.success === false ||
      (Array.isArray(result?.failedUrls) &&
        result.failedUrls.includes(doc.originalUrl)) ||
      (pageResult?.success !== true &&
        !skipped &&
        result?.success === false);

    if (skipped === "unchanged") {
      console.log(
        `[parallelUrlTraining] train skipped unchanged url=${doc.originalUrl}`,
      );
      outcomeSummary.unchanged += 1;
      await markUrlUnchanged(doc.originalUrl, userId, agentId, {
        contentHash: pageResult.contentHash,
        pageType: pageResult.page?.pageType || "generic",
        canonicalUrl: doc.metadata?.canonicalUrl || null,
        language: doc.metadata?.language || "en",
        qualityScore: pageResult.qualityScore,
      });
      return;
    }

    if (skipped === "low_quality") {
      const skipReason = `low_quality:${pageResult.skipReason || "below_threshold"}`;
      console.log(
        `[parallelUrlTraining] train skipped low_quality url=${doc.originalUrl} reason=${pageResult.skipReason || "below_threshold"}`,
      );
      outcomeSummary.skipped += 1;
      recordSkipReason(outcomeSummary, skipReason);
      await markUrlSkipped(
        doc.originalUrl,
        userId,
        agentId,
        skipReason,
        {
          canonicalUrl: doc.metadata?.canonicalUrl || null,
          language: doc.metadata?.language || "en",
          qualityScore: pageResult.qualityScore,
          contentHash: pageResult.contentHash,
          pageType: "generic",
        },
      );
      await upsertSkippedTrainingRow({
        TrainingModel,
        userId,
        agentId,
        url: doc.originalUrl,
        reason: skipReason,
        title: doc.metadata?.title || doc.originalUrl,
      });
      if (doc.dataSize > 0) {
        await Client.updateOne(
          { userId },
          { $inc: { currentDataSize: -doc.dataSize } },
        );
      }
      return;
    }

    const status = failed ? 2 : 1;
    const trainingFilter = {
      userId,
      agentId,
      type: 0,
      "webPage.url": doc.originalUrl,
    };
    const existingRows = await TrainingModel.find(trainingFilter)
      .sort({ createdAt: 1 })
      .select("_id")
      .lean();
    const trainingUpdate = {
      userId,
      agentId,
      type: 0,
      content: doc.content,
      dataSize: doc.dataSize,
      trainingStatus: status,
      error: status === 2 ? trainError : null,
      "webPage.url": doc.originalUrl,
      chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
      lastEdit: Date.now(),
    };

    if (existingRows.length > 0) {
      await TrainingModel.updateOne(
        { _id: existingRows[0]._id },
        { $set: trainingUpdate },
      );
      if (existingRows.length > 1) {
        await TrainingModel.deleteMany({
          _id: { $in: existingRows.slice(1).map((row) => row._id) },
        });
      }
    } else {
      await TrainingModel.create(trainingUpdate);
    }

    if (status === 1) {
      outcomeSummary.trained += 1;
      console.log(
        `[parallelUrlTraining] train success url=${doc.originalUrl} chunks=${result.chunkCountPerUrl?.[doc.originalUrl] || 0}`,
      );
      await markUrlProcessed(doc.originalUrl, userId, agentId, {
        contentHash:
          pageResult?.contentHash || pageResult?.page?.content_hash,
        pageType:
          pageResult?.page?.pageType || doc.metadata?.pageType || "generic",
        canonicalUrl: doc.metadata?.canonicalUrl || null,
        language: doc.metadata?.language || "en",
        qualityScore: pageResult?.qualityScore,
      });
    } else {
      anyTrainFailed = true;
      outcomeSummary.failed += 1;
      recordSkipReason(outcomeSummary, trainError || "Failed to train");
      console.log(
        `[parallelUrlTraining] train failed url=${doc.originalUrl} error=${trainError}`,
      );
      await markUrlFailed(doc.originalUrl, userId, agentId, trainError);
    }

    // Keep counters aligned with the actual rows instead of accumulating
    // duplicates across repeated delete/re-add cycles.
    const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
    await recomputeWebPageCounters(TrainingModel, userId, agentId);
  };

  const enqueueTrain = (doc) => {
    trainQueued += 1;
    console.log(
      `[parallelUrlTraining] queued train ${trainQueued}/${totalUrlsCount} url=${summarizeDoc(doc)}`,
    );
    const trainPromise = (async () => {
      await trainLimiter.acquire();
      try {
        console.log(
          `[parallelUrlTraining] train start active<=${embedConcurrency} completed=${trainCompleted}/${trainQueued} url=${doc.originalUrl}`,
        );
        await emitTrainingProgress({
          trainingProcessed: trainCompleted,
          trainingTotal: Math.max(trainQueued, 1),
          trainingFraction: computeOverlapFraction(),
          force: trainQueued === 1,
        });

        const result = await batchService.processDocumentAndTrain(
          [doc],
          userId,
          agentId,
          qdrantIndexName,
          {
            TrainingModel,
            onProgress: async (progress) => {
              const local =
                progress.trainingTotal > 0
                  ? (progress.trainingProcessed || 0) / progress.trainingTotal
                  : 1;
              const overall =
                (trainCompleted + Math.max(0, Math.min(1, local))) /
                Math.max(trainQueued, 1);
              const scrapeFrac =
                totalUrlsCount > 0 ? scrapeCompleted / totalUrlsCount : 1;
              const blended =
                scrapeCompleted < totalUrlsCount
                  ? scrapeFrac * 0.45 + overall * 0.55
                  : overall;
              await emitTrainingProgress({
                trainingProcessed: trainCompleted + local,
                trainingTotal: Math.max(trainQueued, 1),
                trainingFraction: blended,
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
        await finalizeTrainedDoc(doc, result);
      } catch (trainErr) {
        anyTrainFailed = true;
        console.error(
          `[parallelUrlTraining] train failed for ${doc.originalUrl}:`,
          trainErr,
        );
        try {
          await finalizeTrainedDoc(doc, {
            success: false,
            failedUrls: [doc.originalUrl],
            chunkCountPerUrl: {},
            resultsByUrl: {
              [doc.originalUrl]: {
                success: false,
                error: trainErr?.message,
              },
            },
            error: trainErr?.message,
          });
        } catch (finalizeErr) {
          console.error(
            `[parallelUrlTraining] finalize failed for ${doc.originalUrl}:`,
            finalizeErr,
          );
        }
      } finally {
        trainLimiter.release();
        trainCompleted += 1;
        console.log(
          `[parallelUrlTraining] train finished completed=${trainCompleted}/${trainQueued} url=${doc.originalUrl}`,
        );
        await emitTrainingProgress({
          trainingProcessed: trainCompleted,
          trainingTotal: Math.max(trainQueued, 1),
          trainingFraction: computeOverlapFraction(),
          force:
            trainCompleted >= trainQueued && scrapeCompleted >= totalUrlsCount,
        });
      }
    })();
    trainPromises.push(trainPromise);
  };

  const triggerStorageLimitStop = async () => {
    if (stoppedForStorageLimit) return;
    stoppedForStorageLimit = true;
    console.log(
      "[parallelUrlTraining] storage limit exceeded — stopping new scrapes",
    );
    await Client.updateOne(
      { userId },
      { $set: { "upgradePlanStatus.storageLimitExceeded": true } },
    );

    if (typeof onStorageLimit === "function") {
      await onStorageLimit({
        scrapeCompleted,
        totalUrlsCount,
        scrapingStartTime,
      });
    }
  };

  await mapWithConcurrency(urls, scrapeConcurrency, async (url) => {
    try {
      if (stoppedForStorageLimit) {
        return;
      }

      if (!isScrapableWebUrl(url) || isNonContentPath(url)) {
        const reason = isNonContentPath(url)
          ? "Non-content URL skipped (cart/checkout/login/pagination)."
          : nonHtmlSkipError;
        console.log(`Skipping non-content URL: ${url}`);
        outcomeSummary.skipped += 1;
        recordSkipReason(outcomeSummary, reason);
        if (isNonContentPath(url)) {
          await markUrlSkipped(url, userId, agentId, reason);
          await upsertSkippedTrainingRow({
            TrainingModel,
            userId,
            agentId,
            url,
            reason,
          });
        } else {
          await markWebUrlScrapeFailed({
            url,
            userId,
            agentId,
            TrainingModel,
            error: reason,
          });
        }
        return;
      }

      console.log(`[parallelUrlTraining] scrape start url=${url}`);
      const { rawHtml: sourceCode } = await webScraper.scrapeWebpage(url, {
        maxRetries: 2,
        userId,
        jobId,
      });
      console.log(
        `[parallelUrlTraining] scrape done url=${url} html_bytes=${Buffer.byteLength(sourceCode || "", "utf8")}`,
      );

      if (stoppedForStorageLimit) {
        return;
      }

      await markUrlFetched(url, userId, agentId);

      const processResult = await processWebPage(url, sourceCode, chromeCache, {
        userId,
        agentId,
        conversationId: null,
      });
      console.log(
        `[parallelUrlTraining] process done url=${url} has_content=${!!processResult?.content}`,
      );

      if (!processResult?.content) {
        const failedRow = await TrainingModel.findOneAndUpdate(
          { userId, agentId, type: 0, "webPage.url": url },
          {
            $set: {
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
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        await TrainingModel.deleteMany({
          userId,
          agentId,
          type: 0,
          "webPage.url": url,
          _id: { $ne: failedRow._id },
        });
        await markUrlFailed(
          url,
          userId,
          agentId,
          "Failed to process/minify web page content",
        );
        outcomeSummary.failed += 1;
        recordSkipReason(
          outcomeSummary,
          "Failed to process/minify web page content",
        );
        const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
        await recomputeWebPageCounters(TrainingModel, userId, agentId);
        return;
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
        sections,
        product_id,
      } = processResult;

      const docOrSkip = await withSharedLock(async () => {
        if (stoppedForStorageLimit) return { skip: true };

        const canonCheck = await checkCanonicalDuplicate({
          userId,
          agentId,
          pageUrl: url,
          canonicalUrl,
          TrainingModel,
          seenCanonicalKeys,
        });
        if (canonCheck.isDuplicate) {
          const skipReason = `canonical_duplicate:${canonCheck.reason}`;
          console.log(
            `[parallelUrlTraining] Skipping canonical duplicate ${url} → ${canonCheck.duplicateOf} (${canonCheck.reason})`,
          );
          outcomeSummary.skipped += 1;
          recordSkipReason(outcomeSummary, skipReason);
          await markUrlSkipped(
            url,
            userId,
            agentId,
            skipReason,
            {
              canonicalUrl: canonicalUrl || null,
              language: language || "en",
              pageType: pageType || "generic",
            },
          );
          await upsertSkippedTrainingRow({
            TrainingModel,
            userId,
            agentId,
            url,
            reason: skipReason,
            title: title || url,
            duplicateOf: canonCheck.duplicateOf || canonicalUrl || null,
          });
          return { skip: true };
        }

        let navigationDoc = null;

        if (websiteMetadata) {
          const isHome = websiteMetadata._isHomepage === true;
          const shouldStore =
            isHome || (!metadataExtracted && !metadataFromHomepage);

          if (shouldStore) {
            try {
              const websiteData = await WebsiteData.getOrCreate({
                userId,
                ...(agentId ? { agentId } : {}),
              });
              const { _isHomepage, ...cleanMetadata } = websiteMetadata;
              if (
                (!cleanMetadata.categories_list ||
                  cleanMetadata.categories_list.length === 0) &&
                websiteData.categories_list?.length > 0
              ) {
                delete cleanMetadata.categories_list;
              }
              await websiteData.updateData({
                ...cleanMetadata,
                website_url: cleanMetadata.website_url || url,
                domain: cleanMetadata.domain || new URL(url).hostname,
              });
              metadataExtracted = true;
              if (isHome) metadataFromHomepage = true;
              console.log(
                `[parallelUrlTraining] Stored website metadata for user ${userId} from ${url}`,
              );

              if (
                isHome &&
                !navigationDocQueued &&
                Array.isArray(websiteMetadata.categories_list) &&
                websiteMetadata.categories_list.length > 0
              ) {
                navigationDoc = buildNavigationDocument(
                  websiteMetadata.website_url || url,
                  websiteMetadata.categories_list,
                );
                if (navigationDoc) {
                  navigationDocQueued = true;
                }
              }
            } catch (metadataError) {
              console.error(
                `[parallelUrlTraining] Error storing website metadata:`,
                metadataError,
              );
            }
          }
        }

        const contentSize = Buffer.byteLength(content, "utf8");
        const navSize = navigationDoc?.dataSize || 0;
        const clientDoc = await Client.findOne({ userId });
        const currentDataSize = clientDoc?.currentDataSize || 0;
        const maxStorage =
          clientDoc?.customLimits?.isCustomLimits &&
          clientDoc.customLimits?.maxStorage != null
            ? clientDoc.customLimits.maxStorage
            : plan.limits.maxStorage;

        if (currentDataSize + contentSize + navSize > maxStorage) {
          await triggerStorageLimitStop();
          return { skip: true };
        }

        await Client.updateOne(
          { userId },
          { $inc: { currentDataSize: contentSize + navSize } },
        );

        return {
          skip: false,
          doc: {
            type: 0,
            content,
            sourceCode,
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
              product_id: product_id || null,
              sections: Array.isArray(sections) ? sections : undefined,
              type: "webpage",
            },
            originalUrl: url,
          },
          navigationDoc,
        };
      });

      if (!docOrSkip?.skip && docOrSkip?.doc) {
        scrapedDocs.push(docOrSkip.doc);
        enqueueTrain(docOrSkip.doc);
      }
      if (!docOrSkip?.skip && docOrSkip?.navigationDoc) {
        scrapedDocs.push(docOrSkip.navigationDoc);
        enqueueTrain(docOrSkip.navigationDoc);
      }
    } catch (error) {
      const failedRow = await TrainingModel.findOneAndUpdate(
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
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      await TrainingModel.deleteMany({
        userId,
        agentId,
        type: 0,
        "webPage.url": url,
        _id: { $ne: failedRow._id },
      });

      const { recomputeWebPageCounters } = require("../utils/agentPageCounters");
      await recomputeWebPageCounters(TrainingModel, userId, agentId);
      outcomeSummary.failed += 1;
      recordSkipReason(
        outcomeSummary,
        error?.message || "Failed to train",
      );
      await markUrlFailed(
        url,
        userId,
        agentId,
        error?.message || "Failed to train",
      );
    } finally {
      await bumpScrapeProgress();
    }
  });

  await Promise.all(trainPromises);

  if (!stoppedForStorageLimit) {
    await emitScrapingProgress(totalUrlsCount, totalUrlsCount, true);
    if (trainQueued > 0) {
      await emitTrainingProgress({
        trainingProcessed: trainCompleted,
        trainingTotal: trainQueued,
        trainingFraction: 1,
        force: true,
      });
    }
  }

  console.log(
    `[parallelUrlTraining] summary scraped=${scrapedDocs.length}/${totalUrlsCount} queued=${trainQueued} completed=${trainCompleted} failed=${anyTrainFailed} stopped=${stoppedForStorageLimit} trained=${outcomeSummary.trained} skipped=${outcomeSummary.skipped} unchanged=${outcomeSummary.unchanged}`,
  );

  return {
    scrapedDocs,
    trainQueued,
    trainCompleted,
    anyTrainFailed,
    stoppedForStorageLimit,
    trainingSummary: outcomeSummary,
  };
}

/**
 * Retrain path: parallel scrape + overlap train, updating existing TrainingModel rows.
 */
async function runParallelRetrainOverlap(opts) {
  const {
    validEntries,
    userId,
    agentId,
    qdrantIndexName,
    TrainingModel,
    batchService,
    processWebPage,
    webScraper,
    jobId,
    emitScrapingProgress,
    emitTrainingProgress,
    qdrantManager,
    nonHtmlSkipError,
    scrapeConcurrency = DEFAULT_SCRAPE_CONCURRENCY,
    embedConcurrency = DEFAULT_EMBED_CONCURRENCY,
    totalEntries,
  } = opts;

  const chromeCache = {};
  const retrainCanonicalKeys = new Set();
  const withSharedLock = createAsyncLock();
  const trainLimiter = new ConcurrencyLimiter(embedConcurrency);
  const trainPromises = [];

  let scrapeCompleted = 0;
  let trainQueued = 0;
  let trainCompleted = 0;
  let successCount = 0;
  let failCount = 0;
  let lastProgressEmitTime = 0;
  const PROGRESS_EMIT_INTERVAL = 2000;

  console.log(
    `[parallelRetrain] scrape=${scrapeConcurrency} embed=${embedConcurrency} entries=${totalEntries}`,
  );

  async function applyWebPagePagesAddedDelta(prevStatus, newStatus) {
    if (prevStatus === newStatus) return;
    const inc = {};
    if (prevStatus === 1) inc["pagesAdded.success"] = -1;
    else if (prevStatus === 2) inc["pagesAdded.failed"] = -1;
    if (newStatus === 1) inc["pagesAdded.success"] = (inc["pagesAdded.success"] || 0) + 1;
    else if (newStatus === 2) inc["pagesAdded.failed"] = (inc["pagesAdded.failed"] || 0) + 1;
    const filtered = Object.fromEntries(
      Object.entries(inc).filter(([, v]) => v !== 0),
    );
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
    failCount += 1;
  };

  const computeOverlapFraction = () => {
    const scrapeFrac = totalEntries > 0 ? scrapeCompleted / totalEntries : 1;
    const trainFrac = trainQueued > 0 ? trainCompleted / trainQueued : 0;
    if (scrapeCompleted < totalEntries) {
      return Math.max(0, Math.min(1, scrapeFrac * 0.45 + trainFrac * 0.55));
    }
    return Math.max(0, Math.min(1, trainFrac));
  };

  const bumpScrapeProgress = async () => {
    scrapeCompleted += 1;
    const now = Date.now();
    if (
      now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
      scrapeCompleted === 1 ||
      scrapeCompleted >= totalEntries
    ) {
      await emitScrapingProgress(
        scrapeCompleted,
        totalEntries,
        scrapeCompleted < totalEntries || trainQueued > trainCompleted,
      );
      lastProgressEmitTime = now;
    }
  };

  const finalizeRetrainItem = async (item, result) => {
    const pageResult = result?.resultsByUrl?.[item.url];
    const skipped = pageResult?.skipped;
    const failed =
      !result?.success || result?.failedUrls?.includes(item.url);

    if (skipped === "unchanged") {
      console.log(`[parallelRetrain] train skipped unchanged url=${item.url}`);
      await markUrlUnchanged(item.url, userId, agentId, {
        contentHash: pageResult.contentHash,
        pageType: pageResult.page?.pageType || "generic",
        canonicalUrl: item.scrapedDoc?.metadata?.canonicalUrl || null,
        language: item.scrapedDoc?.metadata?.language || "en",
        qualityScore: pageResult.qualityScore,
      });
      successCount += 1;
      return;
    }

    if (skipped === "low_quality") {
      console.log(
        `[parallelRetrain] train skipped low_quality url=${item.url} reason=${pageResult.skipReason || "below_threshold"}`,
      );
      await markUrlSkipped(
        item.url,
        userId,
        agentId,
        `low_quality:${pageResult.skipReason || "below_threshold"}`,
        {
          canonicalUrl: item.scrapedDoc?.metadata?.canonicalUrl || null,
          language: item.scrapedDoc?.metadata?.language || "en",
          qualityScore: pageResult.qualityScore,
          contentHash: pageResult.contentHash,
        },
      );
      try {
        await qdrantManager.deleteByFields({
          user_id: userId?.toString(),
          agent_id: agentId?.toString(),
          url: item.url,
        });
      } catch (delErr) {
        console.warn(
          `[parallelRetrain] low_quality delete warning for ${item.url}:`,
          delErr.message,
        );
      }
      return;
    }

    if (failed) {
      console.log(
        `[parallelRetrain] train failed url=${item.url} error=${result?.error || "Failed to upsert vectors"}`,
      );
      await markEntryFailed({
        entry: item.entry,
        prevStatus: item.prevStatus,
        error: result?.error || "Failed to upsert vectors",
      });
      return;
    }

    console.log(
      `[parallelRetrain] train success url=${item.url} chunks=${result.chunkCountPerUrl?.[item.url] || 0}`,
    );
    await TrainingModel.updateOne(
      { _id: item.entry._id },
      {
        $set: {
          content: item.content,
          dataSize: item.contentSize,
          trainingStatus: 1,
          lastEdit: new Date(),
          chunkCount: result.chunkCountPerUrl?.[item.url] || 0,
          "webPage.url": item.url,
        },
      },
    );

    await markUrlProcessed(item.url, userId, agentId, {
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

    successCount += 1;
  };

  const enqueueTrain = (item) => {
    trainQueued += 1;
    console.log(
      `[parallelRetrain] queued train ${trainQueued}/${totalEntries} url=${item.url}`,
    );
    const trainPromise = (async () => {
      await trainLimiter.acquire();
      try {
        console.log(
          `[parallelRetrain] train start active<=${embedConcurrency} completed=${trainCompleted}/${trainQueued} url=${item.url}`,
        );
        await emitTrainingProgress({
          trainingProcessed: trainCompleted,
          trainingTotal: Math.max(trainQueued, 1),
          trainingFraction: computeOverlapFraction(),
          force: trainQueued === 1,
        });

        const result = await batchService.processDocumentAndTrain(
          [item.scrapedDoc],
          userId,
          agentId,
          qdrantIndexName,
          {
            TrainingModel,
            onProgress: async (progress) => {
              const local =
                progress.trainingTotal > 0
                  ? (progress.trainingProcessed || 0) / progress.trainingTotal
                  : 1;
              const overall =
                (trainCompleted + Math.max(0, Math.min(1, local))) /
                Math.max(trainQueued, 1);
              const scrapeFrac =
                totalEntries > 0 ? scrapeCompleted / totalEntries : 1;
              const blended =
                scrapeCompleted < totalEntries
                  ? scrapeFrac * 0.45 + overall * 0.55
                  : overall;
              await emitTrainingProgress({
                trainingProcessed: trainCompleted + local,
                trainingTotal: Math.max(trainQueued, 1),
                trainingFraction: blended,
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
        await finalizeRetrainItem(item, result);
      } catch (trainErr) {
        console.error(
          `[parallelRetrain] train failed for ${item.url}:`,
          trainErr,
        );
        await markEntryFailed({
          entry: item.entry,
          prevStatus: item.prevStatus,
          error: trainErr?.message || "Failed to upsert vectors",
        });
      } finally {
        trainLimiter.release();
        trainCompleted += 1;
        console.log(
          `[parallelRetrain] train finished completed=${trainCompleted}/${trainQueued} url=${item.url}`,
        );
        await emitTrainingProgress({
          trainingProcessed: trainCompleted,
          trainingTotal: Math.max(trainQueued, 1),
          trainingFraction: computeOverlapFraction(),
          force:
            trainCompleted >= trainQueued && scrapeCompleted >= totalEntries,
        });
      }
    })();
    trainPromises.push(trainPromise);
  };

  await mapWithConcurrency(validEntries, scrapeConcurrency, async (entry) => {
    const url = entry.webPage.url;
    const prevStatus = entry.trainingStatus;

    try {
      if (!isScrapableWebUrl(url) || isNonContentPath(url)) {
        console.log(`[parallelRetrain] Skipping non-content URL: ${url}`);
        await markEntryFailed({
          entry,
          prevStatus,
          error: isNonContentPath(url)
            ? "Non-content URL skipped (cart/checkout/login/pagination)."
            : nonHtmlSkipError,
        });
        return;
      }

      console.log(`[parallelRetrain] scrape start url=${url}`);
      const { rawHtml } = await webScraper.scrapeWebpage(url, {
        maxRetries: 2,
        userId,
        jobId,
      });
      console.log(
        `[parallelRetrain] scrape done url=${url} html_bytes=${Buffer.byteLength(rawHtml || "", "utf8")}`,
      );

      const processResult = await processWebPage(url, rawHtml, chromeCache, {
        userId,
        agentId,
        conversationId: null,
      });
      console.log(
        `[parallelRetrain] process done url=${url} has_content=${!!processResult?.content}`,
      );

      if (!processResult?.content) {
        await markEntryFailed({
          entry,
          prevStatus,
          error: "Failed to process/minify web page content",
        });
        return;
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
        sections,
        product_id,
      } = processResult;

      const itemOrSkip = await withSharedLock(async () => {
        const canonCheck = await checkCanonicalDuplicate({
          userId,
          agentId,
          pageUrl: url,
          canonicalUrl,
          TrainingModel,
          seenCanonicalKeys: retrainCanonicalKeys,
        });
        if (canonCheck.isDuplicate) {
          await markUrlSkipped(
            url,
            userId,
            agentId,
            `canonical_duplicate:${canonCheck.reason}`,
            {
              canonicalUrl: canonicalUrl || null,
              language: language || "en",
              pageType: pageType || "generic",
            },
          );
          return { skip: true };
        }

        const contentSize = Buffer.byteLength(content, "utf8");
        const oldDataSize = entry.dataSize || 0;
        const dataSizeDelta = contentSize - oldDataSize;

        return {
          skip: false,
          item: {
            entry,
            prevStatus,
            url,
            content,
            contentSize,
            dataSizeDelta,
            scrapedDoc: {
              type: 0,
              content,
              sourceCode: rawHtml,
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
                product_id: product_id || null,
                sections: Array.isArray(sections) ? sections : undefined,
                type: "webpage",
              },
              originalUrl: url,
            },
          },
        };
      });

      if (!itemOrSkip?.skip && itemOrSkip?.item) {
        enqueueTrain(itemOrSkip.item);
      }
    } catch (err) {
      console.error(`[parallelRetrain] Error retraining ${url}:`, err);
      await markEntryFailed({
        entry,
        prevStatus,
        error: err?.message || "Scraping failed",
      });
    } finally {
      await bumpScrapeProgress();
    }
  });

  await Promise.all(trainPromises);

  await emitScrapingProgress(totalEntries, totalEntries, false);
  if (trainQueued > 0) {
    await emitTrainingProgress({
      trainingProcessed: trainCompleted,
      trainingTotal: trainQueued,
      trainingFraction: 1,
      force: true,
    });
  }

  console.log(
    `[parallelRetrain] summary entries=${totalEntries} success=${successCount} failed=${failCount} queued=${trainQueued} completed=${trainCompleted}`,
  );

  return { successCount, failCount, trainQueued, trainCompleted };
}

module.exports = {
  runParallelScrapeOverlapTrain,
  runParallelRetrainOverlap,
  DEFAULT_SCRAPE_CONCURRENCY,
  DEFAULT_EMBED_CONCURRENCY,
};
