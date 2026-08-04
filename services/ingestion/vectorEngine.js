/**
 * Legacy test-backend vectorEngine (OpenRouter + Qdrant/bm25 native sparse).
 * Not used by Chataffy — embeddings/upsert go through QdrantService
 * (named dense + hashed sparse) for collection compatibility.
 *
 * Kept as a stub so accidental requires do not crash the process.
 */

function generateDeterministicUUID() {
  throw new Error(
    "vectorEngine.generateDeterministicUUID is disabled in Chataffy; use QdrantService.upsertDocuments",
  );
}

async function vectorizeChunks() {
  throw new Error(
    "vectorEngine.vectorizeChunks is disabled in Chataffy; use processPageForIngestion + QdrantService",
  );
}

module.exports = {
  generateDeterministicUUID,
  vectorizeChunks,
};
