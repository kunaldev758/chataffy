const QdrantVectorStoreManager = require("../QdrantService");
const Url = require("../../models/Url");
const { normalizeToCommonSchema, hashContent } = require("./normalizeSchema");
const { upsertPageToQdrant } = require("./upsertPageToQdrant");
const { processPageForIngestion } = require("../ingestionService");

const CHUNKING_SHARE = 0.15;
const EMBEDDING_SHARE = 0.55;
const UPSERT_SHARE = 0.3;

// Compat exports (previous char/token estimates used by callers)
const DEFAULT_CHUNK_SIZE = 350;
const DEFAULT_CHUNK_OVERLAP = 50;
const CHARS_PER_TOKEN = 4;

/**
 * Whether a webpage training-list row still exists for this agent+url.
 * Checks both free and paid collections (plan-specific) without importing
 * PlanService — PlanService → jobService creates a circular require chain
 * (jobService → BatchTraining → processPageDocuments → PlanService) that
 * can leave PlanService as an empty export and break all trains.
 */
async function webpageHasTrainingRow(
  userId,
  agentId,
  url,
  TrainingModel = null,
) {
  if (!userId || !agentId || !url) return false;
  const filter = { userId, agentId, type: 0, "webPage.url": url };

  if (TrainingModel) {
    return !!(await TrainingModel.exists(filter));
  }

  const Free = require("../../models/TrainingListFreeUsers");
  const Paid = require("../../models/OpenaiTrainingList");
  const [freeHit, paidHit] = await Promise.all([
    Free.exists(filter),
    Paid.exists(filter),
  ]);
  return !!(freeHit || paidHit);
}

/**
 * Resolve raw input for test-backend-style ingestion.
 * Prefer original HTML when available so normalizePage matches test-backend.
 */
// function resolveRawInput(doc) {
//   const meta = doc.metadata || {};
//   const html =
//     doc.sourceCode ||
//     doc.rawHtml ||
//     meta.sourceCode ||
//     meta.rawHtml ||
//     null;
//   if (html && String(html).trim()) return String(html);
//   if (doc.content && String(doc.content).trim()) return String(doc.content);
//   return "";
// }


function resolveRawInput(doc) {
  // 1. Prefer typed extracted content (clean Markdown, FAQs, specs, sections)
  if (doc.content && String(doc.content).trim()) {
    return String(doc.content);
  }
  // 2. Fall back to raw HTML only if extracted content is absent
  const meta = doc.metadata || {};
  const html =
    doc.sourceCode ||
    doc.rawHtml ||
    meta.sourceCode ||
    meta.rawHtml ||
    null;
  if (html && String(html).trim()) return String(html);
  return "";
}


/**
 * Resolve a stable synthetic URL for snippets/files/faqs (no webpage URL).
 */
function resolveDocUrl(doc, userId, agentId) {
  const url = doc.originalUrl || doc.metadata?.url;
  if (url) return url;
  const type = doc.type !== undefined ? doc.type : doc.metadata?.type;
  const title = doc.metadata?.title || "untitled";
  const safeTitle = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48);
  return `local://${userId}/${agentId}/${type || "doc"}/${safeTitle}-${hashContent(
    String(doc.content || "").slice(0, 200),
  ).slice(0, 12)}`;
}

/**
 * Test-backend ingestion pipeline wired into Chataffy train path:
 * normalize → quality gates → contextual summary → structure →
 * tiktoken parent(850)/child(350) → upsert via existing QdrantService.
 */
async function processPageDocuments(
  documents,
  userId,
  agentId,
  qdrantIndexName,
  options = {},
) {
  // Optional: caller-supplied model (avoids dual-collection lookup).
  // Do not resolve plan via PlanService here — see webpageHasTrainingRow().
  const { onProgress, TrainingModel = null } = options;

  const chunkCountPerUrl = {};
  const resultsByUrl = {};
  let totalChunks = 0;
  const failedUrls = [];
  const skippedUrls = [];
  let storageMB = 0;
  let estimatedCost = null;

  const docTotal = documents.length;
  const vectorStore = new QdrantVectorStoreManager(qdrantIndexName);
  await vectorStore.createCollection();

  const emitAggregateProgress = async ({
    docIndex,
    localFraction,
    step,
    ...details
  }) => {
    if (!onProgress || docTotal <= 0) return;

    const boundedLocal = Math.max(0, Math.min(1, localFraction));
    const trainingFraction = Math.max(
      0,
      Math.min(1, (docIndex + boundedLocal) / docTotal),
    );

    await onProgress({
      phase: "training",
      trainingProcessed: docIndex + boundedLocal,
      trainingTotal: docTotal,
      trainingFraction,
      completedUrls: docIndex,
      currentUrlIndex: docIndex + 1,
      step,
      ...details,
    });
  };

  for (let docIndex = 0; docIndex < documents.length; docIndex++) {
    const doc = documents[docIndex];
    const url = resolveDocUrl(doc, userId, agentId);
    const meta = doc.metadata || {};

    try {
      const rawInput = resolveRawInput(doc);
      if (!rawInput.trim()) {
        console.warn("[url-training:skipped]", {
          agentId,
          url,
          stage: "ingestion",
          reason: "empty_input",
          documentIndex: docIndex,
        });
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "low_quality",
          skipReason: "empty_input",
          qualityScore: 0,
          contentHash: null,
          page: null,
        };
        await emitAggregateProgress({
          docIndex,
          localFraction: 1,
          step: "chunking",
        });
        continue;
      }

      const docType = doc.type !== undefined ? doc.type : 0;
      // Webpage (0): strict test-backend gates. Other training types: lenient.
      const isWebpage = docType === 0;
      const qualityMode = isWebpage ? "strict" : "lenient";

      const ingested = await processPageForIngestion(rawInput, url, {
        userId,
        agentId,
        botId: agentId,
        qualityMode,
        // Keep extractByPageType metadata so QueryController filters still work
        preferPageType: meta.pageType || undefined,
        preferEntityType: meta.entity_type || undefined,
        preferEntityName: meta.entity_name || meta.title || undefined,
        productId: meta.product_id || null,
        searchTerms: meta.search_terms || [],
        extraAttributes: meta.attributes || {},
        classificationConfidence:
          typeof meta.classification_confidence === "number"
            ? meta.classification_confidence
            : undefined,
        classificationReason:
          meta.classification_reason || "test_backend_ingestion",
      });

      const content_hash =
        ingested.contentHash ||
        (ingested.normalizedText
          ? hashContent(ingested.normalizedText)
          : hashContent(rawInput));

      const page = normalizeToCommonSchema({
        url,
        userId,
        agentId,
        content: ingested.normalizedText || rawInput,
        title: meta.title || ingested.pageTitle || "",
        metaDescription: meta.metaDescription || "",
        canonicalUrl: meta.canonicalUrl || null,
        language: meta.language || "en",
        pageType:
          meta.pageType || ingested.pageType || "generic",
        entity_type:
          meta.entity_type || ingested.entity_type || "general",
        entity_name:
          meta.entity_name || ingested.pageTitle || null,
        attributes: {
          ...(meta.attributes || {}),
          ...(ingested.attributes || {}),
          source_page_type: ingested.sourcePageType || null,
        },
        product_id: meta.product_id || null,
        search_terms: meta.search_terms || [],
        classification_confidence:
          typeof meta.classification_confidence === "number"
            ? meta.classification_confidence
            : 1,
        classification_reason:
          meta.classification_reason || "test_backend_ingestion",
        type: docType,
      });
      page.content_hash = content_hash;
      page.pipeline_version = "pc_hybrid_tiktoken_v1";
      page.quality_score = ingested.skipped
        ? 0
        : ingested.metrics?.wordCount || null;

      if (ingested.skipped) {
        console.warn("[url-training:skipped]", {
          agentId,
          url,
          stage: "quality_gate",
          reason: ingested.skipReason || "quality_gate_fail",
          qualityMode,
          wordCount: ingested.metrics?.wordCount ?? null,
          documentIndex: docIndex,
        });
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "low_quality",
          skipReason: ingested.skipReason || "quality_gate_fail",
          qualityScore: page.quality_score,
          contentHash: content_hash,
          page,
        };
        await emitAggregateProgress({
          docIndex,
          localFraction: 1,
          step: "chunking",
        });
        continue;
      }

      // Content-hash skip only when page is truly still trained (row still in
      // training list). After delete, Url.contentHash can remain while vectors
      // and the list row are gone — re-embed and recreate the row.
      const existing = await Url.findOne({ url, userId, agentId })
        .select("contentHash trainStatus")
        .lean();

      if (
        existing?.contentHash &&
        content_hash &&
        existing.contentHash === content_hash
      ) {
        const hasTrainingEntry = await webpageHasTrainingRow(
          userId,
          agentId,
          url,
          TrainingModel,
        );

        if (hasTrainingEntry) {
          console.info("[url-training:unchanged]", {
            agentId,
            url,
            stage: "content_hash_check",
            reason: "content_hash_match",
            documentIndex: docIndex,
          });
          chunkCountPerUrl[url] = 0;
          skippedUrls.push(url);
          resultsByUrl[url] = {
            success: true,
            skipped: "unchanged",
            skipReason: "content_hash_match",
            qualityScore: page.quality_score,
            contentHash: content_hash,
            page,
          };
          await emitAggregateProgress({
            docIndex,
            localFraction: 1,
            step: "chunking",
          });
          continue;
        }

        console.log(
          `[contentPipeline] content hash match for ${url} but no training row — forcing retrain`,
        );
      }

      const allChunks = ingested.chunks || [];
      chunkCountPerUrl[url] = allChunks.length;
      totalChunks += allChunks.length;

      await emitAggregateProgress({
        docIndex,
        localFraction: CHUNKING_SHARE,
        step: "chunking",
      });

      const upsertResult = await upsertPageToQdrant({
        qdrantIndexName,
        userId,
        agentId,
        page,
        chunks: allChunks,
        vectorStore,
        onProgress: onProgress
          ? async (event) => {
            if (event.step === "embedding") {
              const ratio =
                event.total > 0 ? event.embedded / event.total : 1;
              await emitAggregateProgress({
                docIndex,
                localFraction: CHUNKING_SHARE + ratio * EMBEDDING_SHARE,
                embeddingProgress: event.embedded,
                embeddingTotal: event.total,
                step: "embedding",
              });
            } else if (event.step === "upserting") {
              const ratio =
                event.total > 0 ? event.upserted / event.total : 1;
              await emitAggregateProgress({
                docIndex,
                localFraction:
                  CHUNKING_SHARE + EMBEDDING_SHARE + ratio * UPSERT_SHARE,
                embeddingProgress: event.total,
                embeddingTotal: event.total,
                upsertProgress: event.upserted,
                upsertTotal: event.total,
                step: "upserting",
              });
            }
          }
          : undefined,
      });

      if (!upsertResult.success) {
        failedUrls.push(url);
        resultsByUrl[url] = {
          success: false,
          error: upsertResult.error,
          page,
        };
      } else {
        if (upsertResult.storageMB) storageMB += upsertResult.storageMB;
        if (upsertResult.estimatedCost) {
          estimatedCost = upsertResult.estimatedCost;
        }
        resultsByUrl[url] = {
          success: true,
          chunkCount: allChunks.length,
          parentCount: ingested.parentCount,
          childCount: ingested.childCount,
          contextualSummary: ingested.contextualSummary,
          page,
          contentHash: content_hash,
          qualityScore: page.quality_score,
        };
      }
    } catch (err) {
      console.error(
        `[contentPipeline] processPageDocuments failed for ${url}:`,
        err,
      );
      failedUrls.push(url);
      resultsByUrl[url] = { success: false, error: err.message };
      await emitAggregateProgress({
        docIndex,
        localFraction: 1,
        step: "upserting",
      });
    }
  }

  return {
    success: failedUrls.length === 0,
    totalChunks,
    chunkCountPerUrl,
    failedUrls,
    skippedUrls,
    storageMB,
    estimatedCost,
    resultsByUrl,
  };
}

module.exports = {
  processPageDocuments,
  webpageHasTrainingRow,
  resolveRawInput,
  resolveDocUrl,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  CHARS_PER_TOKEN,
};
