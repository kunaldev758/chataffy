const STORAGE_LIMIT_ERROR_TYPE = "STORAGE_LIMIT";
const STORAGE_LIMIT_ERROR = "Storage limit exceeded";
const SKIPPED_ERROR_TYPE = "SKIPPED";

function isSkippedTrainingError(error, errorType) {
  if (errorType === SKIPPED_ERROR_TYPE) return true;
  const msg = String(error || "").trim();
  if (!msg) return false;
  return /^skipped\b/i.test(msg) || /non-content url skipped/i.test(msg);
}

function skippedTrainingListClause() {
  return {
    trainingStatus: 2,
    $or: [
      { errorType: SKIPPED_ERROR_TYPE },
      { error: { $regex: "^Skipped\\b", $options: "i" } },
      { error: { $regex: "non-content URL skipped", $options: "i" } },
    ],
  };
}

function failedTrainingListClause() {
  return {
    trainingStatus: 2,
    errorType: { $ne: SKIPPED_ERROR_TYPE },
    $nor: [
      { error: { $regex: "^Skipped\\b", $options: "i" } },
      { error: { $regex: "non-content URL skipped", $options: "i" } },
    ],
  };
}

module.exports = {
  STORAGE_LIMIT_ERROR_TYPE,
  STORAGE_LIMIT_ERROR,
  SKIPPED_ERROR_TYPE,
  isSkippedTrainingError,
  skippedTrainingListClause,
  failedTrainingListClause,
};
