const QdrantVectorStoreManager = require("../QdrantService");
const Url = require("../../models/Url");
const { normalizeToCommonSchema } = require("./normalizeSchema");
const { upsertPageToQdrant } = require("./upsertPageToQdrant");
const { scoreQuality, QUALITY_THRESHOLD } = require("./qualityScore");
const {
  structureAwareChunk,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
} = require("./chunking");

const DEFAULT_CHUNK_SIZE = 500; // tokens (compat export)
const DEFAULT_CHUNK_OVERLAP = 100;
const CHARS_PER_TOKEN = 4;

/**
 * Phase 1–4 multi-page train:
 * normalize → quality → hash skip → structure-aware chunk (+ embed prefix) → delete-by-url → upsert.
 */
async function processPageDocuments(
  documents,
  userId,
  agentId,
  qdrantIndexName,
  options = {},
) {
  const { onProgress } = options;
  const qualityThreshold = options.qualityThreshold ?? QUALITY_THRESHOLD;
  const chunkSize =
    options.chunkSizeChars ??
    (options.chunkSize != null
      ? options.chunkSize * CHARS_PER_TOKEN
      : DEFAULT_CHUNK_CHARS);
  const chunkOverlap =
    options.chunkOverlapChars ??
    (options.chunkOverlap != null
      ? options.chunkOverlap * CHARS_PER_TOKEN
      : DEFAULT_OVERLAP_CHARS);

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

  for (let docIndex = 0; docIndex < documents.length; docIndex++) {
    const doc = documents[docIndex];
    const url = doc.originalUrl || doc.metadata?.url;
    try {
      const page = normalizeToCommonSchema({
        url,
        userId,
        agentId,
        content: doc.content,
        title: doc.metadata?.title || "",
        metaDescription: doc.metadata?.metaDescription || "",
        canonicalUrl: doc.metadata?.canonicalUrl || null,
        language: doc.metadata?.language || "en",
        pageType: doc.metadata?.pageType || "generic",
        entity_type: doc.metadata?.entity_type || "general",
        entity_name: doc.metadata?.entity_name || null,
        attributes: doc.metadata?.attributes || {},
        search_terms: doc.metadata?.search_terms || [],
        classification_confidence:
          typeof doc.metadata?.classification_confidence === "number"
            ? doc.metadata.classification_confidence
            : 0,
        classification_reason:
          doc.metadata?.classification_reason || "phase3",
        type: doc.type !== undefined ? doc.type : 0,
      });

      // --- Phase 2: quality gate ---
      const quality = scoreQuality(page.text, { title: page.title });
      page.quality_score = quality.score;

      if (!quality.pass || quality.score < qualityThreshold) {
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "low_quality",
          skipReason: quality.reasons.join(",") || "below_threshold",
          qualityScore: quality.score,
          contentHash: page.content_hash,
          page,
        };
        if (onProgress) {
          await onProgress({
            phase: "training",
            trainingProcessed: docIndex + 1,
            trainingTotal: docTotal,
            step: "chunking",
          });
        }
        continue;
      }

      // --- Phase 2: content-hash skip (unchanged) ---
      const existing = await Url.findOne({ url, agentId })
        .select("contentHash trainStatus")
        .lean();

      if (
        existing?.contentHash &&
        page.content_hash &&
        existing.contentHash === page.content_hash
      ) {
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "unchanged",
          skipReason: "content_hash_match",
          qualityScore: quality.score,
          contentHash: page.content_hash,
          page,
        };
        if (onProgress) {
          await onProgress({
            phase: "training",
            trainingProcessed: docIndex + 1,
            trainingTotal: docTotal,
            step: "chunking",
          });
        }
        continue;
      }

      // --- Phase 4: structure-aware chunking ---
      const chunks = await structureAwareChunk(page.text, {
        chunkSize,
        chunkOverlap,
      });
      chunkCountPerUrl[url] = chunks.length;
      totalChunks += chunks.length;

      if (onProgress) {
        await onProgress({
          phase: "training",
          trainingProcessed: docIndex + 1,
          trainingTotal: docTotal,
          step: "chunking",
        });
      }

      const upsertResult = await upsertPageToQdrant({
        qdrantIndexName,
        userId,
        agentId,
        page,
        chunks,
        vectorStore,
        onProgress: onProgress
          ? async (event) => {
              if (event.step === "embedding") {
                await onProgress({
                  phase: "training",
                  trainingProcessed: docTotal,
                  trainingTotal: docTotal,
                  embeddingProgress: event.embedded,
                  embeddingTotal: event.total,
                  step: "embedding",
                });
              } else if (event.step === "upserting") {
                await onProgress({
                  phase: "training",
                  trainingProcessed: docTotal,
                  trainingTotal: docTotal,
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
          chunkCount: chunks.length,
          page,
          contentHash: page.content_hash,
          qualityScore: quality.score,
        };
      }
    } catch (err) {
      console.error(
        `[contentPipeline] processPageDocuments failed for ${url}:`,
        err,
      );
      failedUrls.push(url);
      resultsByUrl[url] = { success: false, error: err.message };
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
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  CHARS_PER_TOKEN,
};
