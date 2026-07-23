/**
 * In-process instrumentation for content-pipeline classification LLM usage.
 * Use getLlmUsageStats() / resetLlmUsageStats() when tuning thresholds.
 */

function emptyBucket() {
  return {
    calls: 0,
    skipped: 0,
    skipReasons: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    estimatedCostUsd: 0,
    lastCallAt: null,
  };
}

const state = {
  pageType: emptyBucket(),
  section: {
    ...emptyBucket(),
    batches: 0,
    sectionsClassified: 0,
  },
  startedAt: new Date().toISOString(),
};

function bumpSkip(bucket, reason) {
  bucket.skipped += 1;
  const key = String(reason || "unknown");
  bucket.skipReasons[key] = (bucket.skipReasons[key] || 0) + 1;
}

function recordPageTypeLlmUsage({
  skipped = false,
  skipReason = null,
  inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  estimatedCostUsd = 0,
} = {}) {
  const b = state.pageType;
  if (skipped) {
    bumpSkip(b, skipReason);
    return;
  }
  b.calls += 1;
  b.inputTokens += Number(inputTokens) || 0;
  b.outputTokens += Number(outputTokens) || 0;
  b.cacheTokens += Number(cacheTokens) || 0;
  b.estimatedCostUsd += Number(estimatedCostUsd) || 0;
  b.lastCallAt = new Date().toISOString();
}

function recordSectionLlmUsage({
  skipped = false,
  skipReason = null,
  batches = 0,
  sectionsClassified = 0,
  inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  estimatedCostUsd = 0,
} = {}) {
  const b = state.section;
  if (skipped) {
    bumpSkip(b, skipReason);
    return;
  }
  b.calls += 1;
  b.batches += Number(batches) || 0;
  b.sectionsClassified += Number(sectionsClassified) || 0;
  b.inputTokens += Number(inputTokens) || 0;
  b.outputTokens += Number(outputTokens) || 0;
  b.cacheTokens += Number(cacheTokens) || 0;
  b.estimatedCostUsd += Number(estimatedCostUsd) || 0;
  b.lastCallAt = new Date().toISOString();
}

function getLlmUsageStats() {
  const totalCalls = state.pageType.calls + state.section.calls;
  const totalSkipped = state.pageType.skipped + state.section.skipped;
  const totalTokens =
    state.pageType.inputTokens +
    state.pageType.outputTokens +
    state.section.inputTokens +
    state.section.outputTokens;
  const totalCost =
    state.pageType.estimatedCostUsd + state.section.estimatedCostUsd;

  return {
    startedAt: state.startedAt,
    asOf: new Date().toISOString(),
    pageType: { ...state.pageType, skipReasons: { ...state.pageType.skipReasons } },
    section: {
      ...state.section,
      skipReasons: { ...state.section.skipReasons },
    },
    totals: {
      calls: totalCalls,
      skipped: totalSkipped,
      inputTokens:
        state.pageType.inputTokens + state.section.inputTokens,
      outputTokens:
        state.pageType.outputTokens + state.section.outputTokens,
      totalTokens,
      estimatedCostUsd: Number(totalCost.toFixed(8)),
    },
  };
}

function resetLlmUsageStats() {
  state.pageType = emptyBucket();
  state.section = {
    ...emptyBucket(),
    batches: 0,
    sectionsClassified: 0,
  };
  state.startedAt = new Date().toISOString();
  return getLlmUsageStats();
}

function logLlmUsageSummary(label = "contentPipeline") {
  const stats = getLlmUsageStats();
  console.info(
    `[${label}] llmUsage`,
    JSON.stringify({
      totals: stats.totals,
      pageType: {
        calls: stats.pageType.calls,
        skipped: stats.pageType.skipped,
        skipReasons: stats.pageType.skipReasons,
        tokens: stats.pageType.inputTokens + stats.pageType.outputTokens,
        costUsd: Number(stats.pageType.estimatedCostUsd.toFixed(8)),
      },
      section: {
        calls: stats.section.calls,
        skipped: stats.section.skipped,
        skipReasons: stats.section.skipReasons,
        batches: stats.section.batches,
        sectionsClassified: stats.section.sectionsClassified,
        tokens: stats.section.inputTokens + stats.section.outputTokens,
        costUsd: Number(stats.section.estimatedCostUsd.toFixed(8)),
      },
    }),
  );
  return stats;
}

module.exports = {
  recordPageTypeLlmUsage,
  recordSectionLlmUsage,
  getLlmUsageStats,
  resetLlmUsageStats,
  logLlmUsageSummary,
};
