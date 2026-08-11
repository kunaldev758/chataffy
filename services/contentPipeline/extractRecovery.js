/**
 * Additive extract recovery (A–E):
 * When typed/generic content is thin, optionally probe listing/PDP extractors,
 * keep the typed result as a candidate, and adopt recovery only if materially better.
 *
 * Happy-path extracts are unchanged when content is already healthy or flags are off.
 */

const { extractProductContent } = require("./extractors/product");
const { extractListingContent } = require("./extractors/listing");

const MIN_HEALTHY_WORDS = 30;
const MIN_HEALTHY_CHARS = 250;
const LARGE_HTML_BYTES = 50 * 1024;
const THIN_WITH_LARGE_HTML_WORDS = 40;
const MATERIAL_CHAR_GAIN = 200;

/** Utility / non-content URLs — skip recovery (same spirit as qualityGate). */
const EXCLUDED_RECOVERY_URL =
  /\/(sitemap|cart|checkout|account|login|register|wishlist|order)(\/|$)/i;

function isEnvEnabled(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultValue;
  const v = String(raw).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

/** Scrape-time recovery in extractByPageType. Default on (additive + gated). */
function isExtractRecoveryEnabled() {
  return isEnvEnabled("EXTRACT_RECOVERY_ENABLED", true);
}

/** Train-time thin markdown → re-extract from sourceCode. Default on. */
function isTrainThinHtmlReextractEnabled() {
  return isEnvEnabled("TRAIN_THIN_HTML_REEXTRACT_ENABLED", true);
}

function wordCount(text = "") {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function charCount(text = "") {
  return String(text || "").trim().length;
}

function productSignalCount(attributes = {}) {
  const attrs = attributes && typeof attributes === "object" ? attributes : {};
  const urls = Array.isArray(attrs.product_urls) ? attrs.product_urls.length : 0;
  const products = Array.isArray(attrs.products) ? attrs.products.length : 0;
  const count =
    typeof attrs.product_count === "number" ? attrs.product_count : 0;
  return Math.max(urls, products, count);
}

/**
 * A. Detect unhealthy extraction.
 * @returns {{ healthy: boolean, words: number, chars: number, reason: string|null }}
 */
function isExtractHealthy(content, { htmlLength = 0, title = "" } = {}) {
  const words = wordCount(content);
  const chars = charCount(content);
  const htmlBytes = Number(htmlLength) || 0;

  if (words < MIN_HEALTHY_WORDS) {
    return { healthy: false, words, chars, reason: "low_word_count" };
  }
  if (chars < MIN_HEALTHY_CHARS) {
    return { healthy: false, words, chars, reason: "low_char_count" };
  }
  if (htmlBytes >= LARGE_HTML_BYTES && words < THIN_WITH_LARGE_HTML_WORDS) {
    return { healthy: false, words, chars, reason: "thin_vs_large_html" };
  }

  // Breadcrumb / chrome-only shells (e.g. Home + brand heading)
  const compact = String(content || "")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/[#*\-|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const titleTok = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 4);
  if (
    words <= 12 &&
    (/^(home\s+)+/.test(compact) ||
      (titleTok.length &&
        titleTok.every((t) => compact.includes(t)) &&
        words <= titleTok.length + 4))
  ) {
    return { healthy: false, words, chars, reason: "breadcrumb_shell" };
  }

  return { healthy: true, words, chars, reason: null };
}

function shouldSkipRecoveryForUrl(url = "") {
  if (!url || String(url).startsWith("local://")) return true;
  try {
    const path = new URL(url, "http://localhost").pathname || "";
    return EXCLUDED_RECOVERY_URL.test(path);
  } catch {
    return EXCLUDED_RECOVERY_URL.test(String(url));
  }
}

/**
 * Score a candidate for pick-richest (higher = better).
 */
function scoreCandidate(candidate) {
  if (!candidate) return -1;
  const words = wordCount(candidate.content);
  const chars = charCount(candidate.content);
  const products = productSignalCount(candidate.attributes);
  return words * 4 + Math.min(chars, 8000) * 0.05 + products * 120;
}

/**
 * D. Recovery wins only if materially better than typed baseline.
 */
function isMateriallyBetter(recovery, baseline) {
  if (!recovery || !String(recovery.content || "").trim()) return false;

  const baseWords = wordCount(baseline?.content);
  const baseChars = charCount(baseline?.content);
  const baseProducts = productSignalCount(baseline?.attributes);

  const recWords = wordCount(recovery.content);
  const recChars = charCount(recovery.content);
  const recProducts = productSignalCount(recovery.attributes);

  if (recProducts > baseProducts && recProducts >= 2) return true;
  if (recProducts >= 1 && baseProducts === 0 && recWords >= MIN_HEALTHY_WORDS) {
    return true;
  }
  if (recWords >= Math.max(MIN_HEALTHY_WORDS, baseWords * 2)) return true;
  if (
    recChars >= baseChars + MATERIAL_CHAR_GAIN &&
    recWords >= MIN_HEALTHY_WORDS
  ) {
    return true;
  }
  return false;
}

/**
 * E. Promote page/entity type only when a recovery candidate wins.
 */
function reconcileTypeFromRecovery(kind, prior = {}) {
  if (kind === "listing") {
    return {
      pageType: "product",
      entity_type: "listing",
      reasonSuffix: "recovery:listing",
    };
  }
  if (kind === "product") {
    return {
      pageType: "product",
      entity_type: "product",
      reasonSuffix: "recovery:product",
    };
  }
  return {
    pageType: prior.pageType,
    entity_type: prior.entity_type,
    reasonSuffix: null,
  };
}

/**
 * B–E: Run recovery probes when unhealthy; keep typed as candidate.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.html
 * @param {object} opts.baseline - current typed/generic merged extract fields
 * @param {object} [opts.pageMetadata]
 * @param {boolean} [opts.alreadyRanListing]
 * @param {boolean} [opts.alreadyRanProduct]
 * @param {boolean} [opts.isProductDetail]
 * @returns {Promise<{ applied: boolean, outcome: string, baselineHealth: object, winner: object|null }>}
 */
async function maybeRecoverExtract({
  url,
  html,
  baseline,
  pageMetadata = {},
  alreadyRanListing = false,
  alreadyRanProduct = false,
  isProductDetail = false,
} = {}) {
  const empty = {
    applied: false,
    outcome: "skipped",
    baselineHealth: { healthy: true, words: 0, chars: 0, reason: null },
    winner: null,
  };

  if (!isExtractRecoveryEnabled()) {
    return { ...empty, outcome: "flag_off" };
  }

  const baselineContent = baseline?.content || "";
  const htmlLength = Buffer.byteLength(String(html || ""), "utf8");
  const baselineHealth = isExtractHealthy(baselineContent, {
    htmlLength,
    title: baseline?.title || pageMetadata.title || "",
  });

  if (baselineHealth.healthy) {
    return { ...empty, outcome: "healthy", baselineHealth };
  }

  if (shouldSkipRecoveryForUrl(url)) {
    return { ...empty, outcome: "excluded_url", baselineHealth };
  }

  const jsonLdBlocks = pageMetadata.jsonLdBlocks || [];
  const title = baseline?.title || pageMetadata.title || "";
  const metaDescription =
    baseline?.metaDescription || pageMetadata.metaDescription || "";

  const typedCandidate = {
    kind: "typed",
    content: baselineContent,
    entity_name: baseline?.entity_name || null,
    attributes: baseline?.attributes || {},
    search_terms: Array.isArray(baseline?.search_terms)
      ? baseline.search_terms
      : [],
    extraction_source: baseline?.extraction_source || "generic",
  };

  const probes = [];
  // Prefer listing probe for non-PDP; still allow both when neither ran.
  const wantListing = !alreadyRanListing;
  const wantProduct = !alreadyRanProduct;

  if (wantListing) {
    probes.push({
      kind: "listing",
      run: () =>
        extractListingContent({
          url,
          html,
          jsonLdBlocks,
          title,
          metaDescription,
        }),
    });
  }
  if (wantProduct) {
    probes.push({
      kind: "product",
      run: () =>
        extractProductContent({
          url,
          html,
          jsonLdBlocks,
        }),
    });
  }

  if (!probes.length) {
    return { ...empty, outcome: "no_probes", baselineHealth };
  }

  // Prefer PDP probe first on clear product URLs (run in parallel anyway).
  if (isProductDetail && wantProduct && wantListing) {
    probes.sort((a, b) => (a.kind === "product" ? -1 : b.kind === "product" ? 1 : 0));
  }

  const settled = await Promise.all(
    probes.map(async (p) => {
      try {
        const result = await Promise.resolve(p.run());
        if (!result || !String(result.content || "").trim()) {
          return null;
        }
        return {
          kind: p.kind,
          content: String(result.content || "").trim(),
          entity_name: result.entity_name || null,
          attributes: result.attributes || {},
          search_terms: Array.isArray(result.search_terms)
            ? result.search_terms
            : [],
          extraction_source: result.extraction_source
            ? `recovery:${result.extraction_source}`
            : `recovery:${p.kind}`,
        };
      } catch (err) {
        console.warn(
          `[extractRecovery] ${p.kind} probe failed for ${url}: ${err.message}`,
        );
        return null;
      }
    }),
  );

  const recoveryCandidates = settled.filter(Boolean);
  if (!recoveryCandidates.length) {
    console.info("[extractRecovery]", {
      url,
      outcome: "recovery_exhausted",
      baselineWords: baselineHealth.words,
      reason: baselineHealth.reason,
    });
    return { ...empty, outcome: "recovery_exhausted", baselineHealth };
  }

  // Best recovery among probes
  let bestRecovery = recoveryCandidates[0];
  let bestScore = scoreCandidate(bestRecovery);
  for (let i = 1; i < recoveryCandidates.length; i++) {
    const s = scoreCandidate(recoveryCandidates[i]);
    if (s > bestScore) {
      bestScore = s;
      bestRecovery = recoveryCandidates[i];
    }
  }

  if (!isMateriallyBetter(bestRecovery, typedCandidate)) {
    console.info("[extractRecovery]", {
      url,
      outcome: "recovery_kept_typed",
      baselineWords: baselineHealth.words,
      recoveryKind: bestRecovery.kind,
      recoveryWords: wordCount(bestRecovery.content),
    });
    return {
      applied: false,
      outcome: "recovery_kept_typed",
      baselineHealth,
      winner: null,
    };
  }

  const reconciled = reconcileTypeFromRecovery(bestRecovery.kind, {
    pageType: baseline?.pageType,
    entity_type: baseline?.entity_type,
  });

  const winner = {
    ...bestRecovery,
    pageType: reconciled.pageType,
    entity_type: reconciled.entity_type,
    reasonSuffix: reconciled.reasonSuffix,
  };

  console.info("[extractRecovery]", {
    url,
    outcome: "recovery_used",
    kind: bestRecovery.kind,
    baselineWords: baselineHealth.words,
    recoveryWords: wordCount(bestRecovery.content),
    products: productSignalCount(bestRecovery.attributes),
  });

  return {
    applied: true,
    outcome: "recovery_used",
    baselineHealth,
    winner,
  };
}

/**
 * G. Train-time: if stored markdown is thin but sourceCode exists, re-run
 * extractByPageType (which includes scrape-time recovery when enabled).
 * Mutates doc.content / doc.metadata only when re-extract is materially better.
 */
async function maybeReextractThinDocument(
  doc,
  { chromeCache = {}, usageContext = {} } = {},
) {
  if (!isTrainThinHtmlReextractEnabled()) {
    return { applied: false, outcome: "flag_off" };
  }
  if (!doc || typeof doc !== "object") {
    return { applied: false, outcome: "no_doc" };
  }

  const meta = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  const content = String(doc.content || "").trim();
  const html =
    doc.sourceCode ||
    doc.rawHtml ||
    meta.sourceCode ||
    meta.rawHtml ||
    null;
  if (!html || !String(html).trim()) {
    return { applied: false, outcome: "no_html" };
  }

  const url = doc.originalUrl || meta.url || null;
  if (!url || String(url).startsWith("local://")) {
    return { applied: false, outcome: "no_url" };
  }
  if (shouldSkipRecoveryForUrl(url)) {
    return { applied: false, outcome: "excluded_url" };
  }

  const htmlLength = Buffer.byteLength(String(html), "utf8");
  const health = isExtractHealthy(content, {
    htmlLength,
    title: meta.title || "",
  });
  if (health.healthy) {
    return { applied: false, outcome: "healthy", health };
  }

  // Lazy require avoids circular load with extractByPageType → extractRecovery
  const { extractByPageType } = require("./extractByPageType");
  let extracted;
  try {
    extracted = await extractByPageType(url, html, chromeCache, usageContext);
  } catch (err) {
    console.warn(
      `[extractRecovery] train re-extract failed for ${url}: ${err.message}`,
    );
    return { applied: false, outcome: "reextract_error", health };
  }

  if (!extracted?.content || !String(extracted.content).trim()) {
    return { applied: false, outcome: "reextract_empty", health };
  }

  const recovered = {
    content: String(extracted.content).trim(),
    attributes: extracted.attributes || {},
  };
  const baseline = {
    content,
    attributes: meta.attributes || {},
  };

  if (!isMateriallyBetter(recovered, baseline)) {
    console.info("[extractRecovery]", {
      url,
      outcome: "train_kept_thin",
      baselineWords: health.words,
      recoveredWords: wordCount(recovered.content),
    });
    return { applied: false, outcome: "train_kept_thin", health };
  }

  doc.content = recovered.content;
  doc.metadata = {
    ...meta,
    title: extracted.title || meta.title,
    metaDescription: extracted.metaDescription || meta.metaDescription,
    canonicalUrl: extracted.canonicalUrl ?? meta.canonicalUrl,
    language: extracted.language || meta.language,
    pageType: extracted.pageType || meta.pageType,
    entity_type: extracted.entity_type || meta.entity_type,
    entity_name: extracted.entity_name || meta.entity_name,
    attributes: extracted.attributes || meta.attributes || {},
    search_terms: extracted.search_terms || meta.search_terms || [],
    classification_confidence:
      typeof extracted.classification_confidence === "number"
        ? extracted.classification_confidence
        : meta.classification_confidence,
    classification_reason: [
      meta.classification_reason,
      "train_thin_html_reextract",
      extracted.classification_reason,
    ]
      .filter(Boolean)
      .join("+"),
    extraction_source: extracted.extraction_source || meta.extraction_source,
    product_id: extracted.product_id ?? meta.product_id ?? null,
    sections: extracted.sections || meta.sections,
  };

  console.info("[extractRecovery]", {
    url,
    outcome: "train_reextract_used",
    baselineWords: health.words,
    recoveredWords: wordCount(recovered.content),
    pageType: doc.metadata.pageType,
    entity_type: doc.metadata.entity_type,
  });

  return {
    applied: true,
    outcome: "train_reextract_used",
    health,
  };
}

module.exports = {
  isEnvEnabled,
  isExtractRecoveryEnabled,
  isTrainThinHtmlReextractEnabled,
  isExtractHealthy,
  shouldSkipRecoveryForUrl,
  scoreCandidate,
  isMateriallyBetter,
  reconcileTypeFromRecovery,
  maybeRecoverExtract,
  maybeReextractThinDocument,
  wordCount,
  charCount,
  productSignalCount,
  MIN_HEALTHY_WORDS,
  MIN_HEALTHY_CHARS,
};
