const SCRAPE_WEIGHT = 75;
const TRAIN_WEIGHT = 25;
const MAX_PROCESSING_PERCENT = 99;

const TRAINING_CHUNKING_SHARE = 0.15;
const TRAINING_EMBEDDING_SHARE = 0.55;
const TRAINING_UPSERT_SHARE = 0.3;

function formatElapsedTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function computeTrainingFraction({
  trainingFraction,
  trainingStep = "chunking",
  trainingProcessed = 0,
  trainingTotal = 0,
  embeddingProgress = 0,
  embeddingTotal = 0,
  upsertProgress = 0,
  upsertTotal = 0,
}) {
  if (Number.isFinite(trainingFraction)) {
    return Math.max(0, Math.min(1, trainingFraction));
  }
  if (trainingStep === "upserting" && upsertTotal > 0) {
    return (
      TRAINING_CHUNKING_SHARE +
      TRAINING_EMBEDDING_SHARE +
      (upsertProgress / upsertTotal) * TRAINING_UPSERT_SHARE
    );
  }
  if (trainingStep === "embedding" && embeddingTotal > 0) {
    return (
      TRAINING_CHUNKING_SHARE +
      (embeddingProgress / embeddingTotal) * TRAINING_EMBEDDING_SHARE
    );
  }
  if (trainingTotal > 0) {
    return (trainingProcessed / trainingTotal) * TRAINING_CHUNKING_SHARE;
  }
  return 0;
}

function computeOverallPercentage({
  phase = "scraping",
  processed = 0,
  total = 0,
  trainingFraction,
  trainingStep = "chunking",
  trainingProcessed = 0,
  trainingTotal = 0,
  embeddingProgress = 0,
  embeddingTotal = 0,
  upsertProgress = 0,
  upsertTotal = 0,
  isProcessing = true,
}) {
  let pct;
  if (phase === "training") {
    const trainFrac = computeTrainingFraction({
      trainingFraction,
      trainingStep,
      trainingProcessed,
      trainingTotal,
      embeddingProgress,
      embeddingTotal,
      upsertProgress,
      upsertTotal,
    });
    pct = Math.round(SCRAPE_WEIGHT + trainFrac * TRAIN_WEIGHT);
  } else if (total <= 0) {
    pct = 0;
  } else {
    pct = Math.round((processed / total) * SCRAPE_WEIGHT);
  }

  if (isProcessing) {
    return Math.min(MAX_PROCESSING_PERCENT, pct);
  }
  return 100;
}

function buildTrainingProgressPayload({
  startTime,
  trainingStartTime,
  phase = "scraping",
  processed = 0,
  total = 0,
  trainingFraction,
  trainingStep = "chunking",
  trainingProcessed = 0,
  trainingTotal = 0,
  embeddingProgress = 0,
  embeddingTotal = 0,
  upsertProgress = 0,
  upsertTotal = 0,
  isProcessing = true,
  stoppedReason,
  error,
}) {
  const start = startTime ? new Date(startTime) : new Date();
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - start.getTime()) / 1000),
  );

  let estimatedSecondsRemaining = null;
  if (phase === "scraping" && processed > 0 && total > processed) {
    const avgPerPage = elapsedSeconds / processed;
    estimatedSecondsRemaining = Math.round(avgPerPage * (total - processed));
  } else if (
    phase === "training" &&
    Number.isFinite(trainingFraction) &&
    trainingFraction > 0 &&
    trainingFraction < 1
  ) {
    const trainingStart = trainingStartTime
      ? new Date(trainingStartTime)
      : start;
    const trainingElapsedSeconds = Math.max(
      0,
      (Date.now() - trainingStart.getTime()) / 1000,
    );
    estimatedSecondsRemaining = Math.max(
      0,
      Math.round(
        (trainingElapsedSeconds / trainingFraction) * (1 - trainingFraction),
      ),
    );
  }

  const percentage = computeOverallPercentage({
    phase,
    processed,
    total,
    trainingFraction,
    trainingStep,
    trainingProcessed,
    trainingTotal,
    embeddingProgress,
    embeddingTotal,
    upsertProgress,
    upsertTotal,
    isProcessing,
  });

  return {
    percentage,
    processed,
    total,
    trainingStep,
    ...(Number.isFinite(trainingFraction)
      ? { trainingFraction: Math.max(0, Math.min(1, trainingFraction)) }
      : {}),
    trainingProcessed,
    trainingTotal,
    embeddingProgress,
    embeddingTotal,
    upsertProgress,
    upsertTotal,
    elapsedTime: formatElapsedTime(elapsedSeconds),
    elapsedSeconds,
    estimatedTimeRemaining: estimatedSecondsRemaining
      ? formatElapsedTime(estimatedSecondsRemaining)
      : null,
    estimatedSecondsRemaining,
    isProcessing,
    phase,
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(error ? { error } : {}),
  };
}

module.exports = {
  SCRAPE_WEIGHT,
  TRAIN_WEIGHT,
  MAX_PROCESSING_PERCENT,
  formatElapsedTime,
  computeTrainingFraction,
  computeOverallPercentage,
  buildTrainingProgressPayload,
};
