const QdrantVectorStoreManager = require("../QdrantService");
const Url = require("../../models/Url");
const { normalizeToCommonSchema, hashContent } = require("./normalizeSchema");
const { upsertPageToQdrant } = require("./upsertPageToQdrant");
const { scoreQuality, QUALITY_THRESHOLD } = require("./qualityScore");
const {
  structureAwareParentChildChunk,
  DEFAULT_PARENT_CHARS,
  DEFAULT_CHILD_CHARS,
} = require("./chunking");

const USE_PARENT_CHILD = process.env.RAG_PARENT_CHILD !== "false";

const DEFAULT_CHUNK_SIZE = 500; // tokens (compat export)
const DEFAULT_CHUNK_OVERLAP = 100;
const CHARS_PER_TOKEN = 4;
const CHUNKING_SHARE = 0.15;
const EMBEDDING_SHARE = 0.55;
const UPSERT_SHARE = 0.3;

/**
 * Resolve sections for a scraped doc. Falls back to a single primary section.
 */
function resolveSections(doc) {
  const meta = doc.metadata || {};
  if (Array.isArray(meta.sections) && meta.sections.length > 0) {
    return meta.sections
      .map((s) => ({
        pageType: s.pageType || meta.pageType || "generic",
        entity_type: s.entity_type || meta.entity_type || "general",
        entity_name:
          s.entity_name !== undefined ? s.entity_name : meta.entity_name || null,
        content: String(s.content || "").trim(),
        attributes:
          s.attributes && typeof s.attributes === "object"
            ? s.attributes
            : meta.attributes || {},
        search_terms: Array.isArray(s.search_terms)
          ? s.search_terms
          : meta.search_terms || [],
        classification_confidence:
          typeof s.classification_confidence === "number"
            ? s.classification_confidence
            : typeof meta.classification_confidence === "number"
              ? meta.classification_confidence
              : 0,
        classification_reason:
          s.classification_reason || meta.classification_reason || "phase3",
        extraction_source: s.extraction_source || meta.extraction_source,
        product_id: s.product_id ?? meta.product_id ?? null,
      }))
      .filter((s) => s.content);
  }

  return [
    {
      pageType: meta.pageType || "generic",
      entity_type: meta.entity_type || "general",
      entity_name: meta.entity_name || null,
      content: String(doc.content || "").trim(),
      attributes: meta.attributes || {},
      search_terms: meta.search_terms || [],
      classification_confidence:
        typeof meta.classification_confidence === "number"
          ? meta.classification_confidence
          : 0,
      classification_reason: meta.classification_reason || "phase3",
      extraction_source: meta.extraction_source,
      product_id: meta.product_id ?? null,
    },
  ].filter((s) => s.content);
}

/**
 * Phase 1–4 multi-page train:
 * normalize → per-section quality → hash skip → structure-aware chunk
 * (+ embed prefix) → delete-by-url → upsert (chunks may differ by entity_type).
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
  const parentSize =
    options.parentSizeChars ??
    options.chunkSizeChars ??
    DEFAULT_PARENT_CHARS;
  const childSize = options.childSizeChars ?? DEFAULT_CHILD_CHARS;

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
    const url = doc.originalUrl || doc.metadata?.url;
    try {
      const sections = resolveSections(doc);
      const meta = doc.metadata || {};

      // --- Phase 2: per-section quality (one weak section does not kill others) ---
      const keptSections = [];
      const sectionQualityScores = [];
      for (const section of sections) {
        const quality = scoreQuality(section.content, {
          title: section.entity_name || meta.title || "",
        });
        sectionQualityScores.push(quality.score);
        if (quality.pass && quality.score >= qualityThreshold) {
          keptSections.push({
            ...section,
            quality_score: quality.score,
          });
        }
      }

      const combinedText = keptSections.map((s) => s.content).join("\n\n");
      const content_hash = combinedText ? hashContent(combinedText) : null;
      const bestQuality =
        sectionQualityScores.length > 0
          ? Math.max(...sectionQualityScores)
          : 0;

      const page = normalizeToCommonSchema({
        url,
        userId,
        agentId,
        content: combinedText || doc.content,
        title: meta.title || "",
        metaDescription: meta.metaDescription || "",
        canonicalUrl: meta.canonicalUrl || null,
        language: meta.language || "en",
        pageType: meta.pageType || keptSections[0]?.pageType || "generic",
        entity_type:
          meta.entity_type || keptSections[0]?.entity_type || "general",
        entity_name: meta.entity_name || keptSections[0]?.entity_name || null,
        attributes: meta.attributes || keptSections[0]?.attributes || {},
        product_id:
          meta.product_id || keptSections[0]?.product_id || null,
        search_terms: meta.search_terms || [],
        classification_confidence:
          typeof meta.classification_confidence === "number"
            ? meta.classification_confidence
            : keptSections[0]?.classification_confidence || 0,
        classification_reason:
          meta.classification_reason ||
          keptSections[0]?.classification_reason ||
          "phase3",
        type: doc.type !== undefined ? doc.type : 0,
      });
      page.quality_score = bestQuality;
      page.content_hash = content_hash;

      if (keptSections.length === 0) {
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "low_quality",
          skipReason: "all_sections_below_threshold",
          qualityScore: bestQuality,
          contentHash: content_hash,
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
        content_hash &&
        existing.contentHash === content_hash
      ) {
        chunkCountPerUrl[url] = 0;
        skippedUrls.push(url);
        resultsByUrl[url] = {
          success: true,
          skipped: "unchanged",
          skipReason: "content_hash_match",
          qualityScore: bestQuality,
          contentHash: content_hash,
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

      // --- Parent-child chunking per section (embed children, store parent on payload) ---
      const allChunks = [];
      for (const section of keptSections) {
        const parts = USE_PARENT_CHILD
          ? await structureAwareParentChildChunk(section.content, {
              parentSize,
              childSize,
              entity_type: section.entity_type,
              pageType: section.pageType,
            })
          : await (async () => {
              const { structureAwareChunk } = require("./chunking");
              const legacy = await structureAwareChunk(section.content, {
                chunkSize: parentSize,
                chunkOverlap: 200,
                entity_type: section.entity_type,
                pageType: section.pageType,
              });
              return legacy.map((p, i) => ({
                ...p,
                parent_text: p.text,
                parent_id: null,
                parent_index: 0,
                child_index: i,
                chunk_role: "child",
              }));
            })();

        for (const part of parts) {
          allChunks.push({
            text: part.text,
            parent_text: part.parent_text,
            parent_id: part.parent_id,
            parent_index: part.parent_index,
            child_index: part.child_index,
            chunk_role: part.chunk_role || "child",
            heading_path: part.heading_path || "",
            pageType: section.pageType,
            entity_type: section.entity_type,
            entity_name: section.entity_name,
            product_id: section.product_id || null,
            attributes: section.attributes,
            search_terms: section.search_terms,
            classification_confidence: section.classification_confidence,
            classification_reason: section.classification_reason,
            quality_score: section.quality_score,
          });
        }
      }

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
                  localFraction:
                    CHUNKING_SHARE + ratio * EMBEDDING_SHARE,
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
                    CHUNKING_SHARE +
                    EMBEDDING_SHARE +
                    ratio * UPSERT_SHARE,
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
          sectionCount: keptSections.length,
          page,
          contentHash: content_hash,
          qualityScore: bestQuality,
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
  resolveSections,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  CHARS_PER_TOKEN,
};
