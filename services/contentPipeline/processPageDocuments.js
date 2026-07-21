const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const QdrantVectorStoreManager = require("../QdrantService");
const { normalizeToCommonSchema } = require("./normalizeSchema");
const { upsertPageToQdrant } = require("./upsertPageToQdrant");

const DEFAULT_CHUNK_SIZE = 500; // tokens
const DEFAULT_CHUNK_OVERLAP = 100;
const CHARS_PER_TOKEN = 4;
const CHUNKING_SHARE = 0.15;
const EMBEDDING_SHARE = 0.55;
const UPSERT_SHARE = 0.3;

/**
 * Phase 1 multi-page train: normalize → recursive chunk → delete-by-url → upsert.
 * Reuses one QdrantVectorStoreManager for the whole batch.
 */
async function processPageDocuments(
  documents,
  userId,
  agentId,
  qdrantIndexName,
  options = {},
) {
  const { onProgress } = options;
  const chunkSize = (options.chunkSize ?? DEFAULT_CHUNK_SIZE) * CHARS_PER_TOKEN;
  const chunkOverlap =
    (options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP) * CHARS_PER_TOKEN;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
  });

  const chunkCountPerUrl = {};
  const resultsByUrl = {};
  let totalChunks = 0;
  const failedUrls = [];
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
      const page = normalizeToCommonSchema({
        url,
        userId,
        agentId,
        content: doc.content,
        title: doc.metadata?.title || "",
        metaDescription: doc.metadata?.metaDescription || "",
        canonicalUrl: doc.metadata?.canonicalUrl || null,
        language: doc.metadata?.language || "en",
        type: doc.type !== undefined ? doc.type : 0,
      });

      const lcDocs = await splitter.createDocuments([page.text]);
      const chunks = lcDocs.map((d) => d.pageContent);
      chunkCountPerUrl[url] = chunks.length;
      totalChunks += chunks.length;

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
        chunks,
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
          chunkCount: chunks.length,
          page,
          contentHash: page.content_hash,
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
