const QdrantVectorStoreManager = require("../QdrantService");
const {
  normalizeToCommonSchema,
  pageToUpsertDocuments,
} = require("./normalizeSchema");

/**
 * Delete existing vectors for a URL, then upsert new chunk points.
 * Phase 1: always delete-then-insert so recrawls do not accumulate stale chunks.
 *
 * @param {object} opts
 * @param {InstanceType<typeof QdrantVectorStoreManager>} [opts.vectorStore] reuse client
 */
async function upsertPageToQdrant({
  qdrantIndexName,
  userId,
  agentId,
  page,
  chunks,
  onProgress,
  vectorStore: existingStore = null,
}) {
  const vectorStore =
    existingStore || new QdrantVectorStoreManager(qdrantIndexName);
  if (!existingStore) {
    await vectorStore.createCollection();
  }

  const url = page.url;
  const deleteFilter = {
    user_id: userId?.toString(),
    url,
  };
  if (agentId != null) {
    deleteFilter.agent_id = agentId.toString();
  }

  const deleteResult = await vectorStore.deleteByFields(deleteFilter);

  if (!deleteResult.success && deleteResult.error !== "Agent deleted") {
    console.warn(
      `[contentPipeline] deleteByFields warning for ${url}: ${deleteResult.error}`,
    );
  }

  if (!chunks.length) {
    return { success: true, vectorCount: 0, deletedOk: deleteResult.success };
  }

  const docs = pageToUpsertDocuments(page, chunks);
  const upsertResult = await vectorStore.upsertDocuments(docs, userId, {
    agentId,
    onProgress,
  });

  return {
    success: upsertResult?.success !== false,
    vectorCount: upsertResult?.vectorCount ?? docs.length,
    storageMB: upsertResult?.storageMB,
    estimatedCost: upsertResult?.estimatedCost,
    failedUrls: upsertResult?.failedUrls || [],
    deletedOk: deleteResult.success,
    error: upsertResult?.error,
  };
}

async function normalizeAndUpsertPage({
  qdrantIndexName,
  userId,
  agentId,
  content,
  url,
  title,
  metaDescription,
  canonicalUrl,
  language,
  chunks,
  onProgress,
  vectorStore = null,
  ...normalizeExtras
}) {
  const page = normalizeToCommonSchema({
    url,
    userId,
    agentId,
    content,
    title,
    metaDescription,
    canonicalUrl,
    language,
    ...normalizeExtras,
  });

  return {
    page,
    ...(await upsertPageToQdrant({
      qdrantIndexName,
      userId,
      agentId,
      page,
      chunks,
      onProgress,
      vectorStore,
    })),
  };
}

module.exports = {
  upsertPageToQdrant,
  normalizeAndUpsertPage,
};
