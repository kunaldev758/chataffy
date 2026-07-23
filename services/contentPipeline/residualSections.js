const cheerio = require("cheerio");
const TurndownService = require("turndown");
const {
  stripInlineBufferImageContent,
  FACET_SIDEBAR_SELECTORS,
} = require("./htmlCleanup");
const { ENTITY_TYPES } = require("./schema");
const { classifySectionsLlm } = require("./classifySectionsLlm");
const { isFacetFilterBlock } = require("./extractors/faq");

/** Rule confidence at or above this skips per-section LLM. */
const SECTION_RULE_THRESHOLD = 0.72;
const MAX_CANDIDATES = 12;
const MIN_SECTION_CHARS = 80;
const MAX_LLM_BATCH_CHARS = 14000;
const OVERLAP_SKIP_RATIO = 0.55;

const COVERED_ATTR = "data-pipeline-covered";

const CHROME_SELECTORS = [
  "header",
  "footer",
  "nav",
  "[role='banner']",
  "[role='navigation']",
  "[role='contentinfo']",
  "#header",
  "#footer",
  "#masthead",
  "#colophon",
  ".site-header",
  ".site-footer",
  ".page-header",
  ".page-footer",
  ".navbar",
  ".main-nav",
  ".breadcrumb",
  ".breadcrumbs",
  ".cookie-banner",
  ".cookie-consent",
  "[class*='cookie']",
  ".advertisement",
  ".ads",
  "[class*='newsletter']",
].join(", ");

const FACET_HEADING_RE =
  /^(collections?|categories|filter|filters|sort by|sort|availability|price|size|color|colour|brand|vendor|product type|tags?)$/i;

const FAQ_SELECTORS = [
  "[itemtype*='FAQPage']",
  ".faq",
  ".faqs",
  "#faq",
  "#faqs",
  "[class*='faq-section']",
  "[id*='faq']",
  "[class*='accordion']",
].join(", ");

const PRODUCT_PRIMARY_SELECTORS = [
  "[itemtype*='Product']",
  "[itemprop='offers']",
  ".product-form",
  ".product__form",
  ".product-single__meta",
  ".product__info",
  ".product-info",
  ".product-details",
  ".product__details",
  ".product-price",
  ".price-box",
  "[data-product-id]",
  "form[action*='cart']",
].join(", ");

const ARTICLE_PRIMARY_SELECTORS = [
  "article",
  "[role='main']",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".blog-post",
  ".docs-content",
  "main",
].join(", ");

const SEMANTIC_SECTION_SELECTORS = [
  "[itemtype*='FAQPage']",
  "[itemtype*='Question']",
  "[itemtype*='Review']",
  "[itemtype*='AggregateRating']",
  ".faq",
  ".faqs",
  "#faq",
  ".reviews",
  "#reviews",
  ".product-reviews",
  "[class*='review']",
  ".related",
  ".related-products",
  "[class*='related-product']",
  ".recommendations",
  "[class*='recommend']",
  "details",
  "[class*='accordion']",
  ".specs",
  ".specifications",
  "[class*='specification']",
  ".shipping",
  ".returns",
  "[class*='warranty']",
].join(", ");

const LINK_LIST_HEADING_RE =
  /related|you may also|similar|see also|more products|customers? also|recommended|shop (the )?(collection|look)|complete the look|frequently bought|bought together/i;
const FAQ_HEADING_RE =
  /faq|frequently asked|questions?\s*&?\s*answers?|common questions/i;
const REVIEW_HEADING_RE =
  /reviews?|ratings?|customer feedback|what (our )?customers say|testimonials?/i;
const POLICY_HEADING_RE =
  /shipping|returns?|refunds?|warranty|guarantee|privacy|terms|exchange|delivery|cancellation/i;
const SPECS_HEADING_RE =
  /specifications?|specs|features|materials?|dimensions?|what's included|whats included|care instructions/i;

function createTurndown() {
  return new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
  });
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function normalizeEntityType(raw) {
  if (!raw) return "general";
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, "_");
  return ENTITY_TYPES.includes(v) ? v : "general";
}

function pageTypeForEntity(entityType, fallbackPageType = "generic") {
  switch (entityType) {
    case "faq":
      return "faq";
    case "blog_post":
      return "blog";
    case "docs":
      return "docs";
    case "product":
    case "listing":
      return "product";
    default:
      return fallbackPageType === "product" ? "generic" : fallbackPageType;
  }
}

/**
 * Mark nodes (and their subtrees) as already consumed by primary extraction.
 */
function markCoveredRegions($, selector) {
  if (!selector) return 0;
  let count = 0;
  $(selector).each((_, el) => {
    const $el = $(el);
    if ($el.attr(COVERED_ATTR) === "1") return;
    $el.attr(COVERED_ATTR, "1");
    count += 1;
  });
  return count;
}

function isInsideCovered($, el) {
  const $el = $(el);
  if ($el.attr(COVERED_ATTR) === "1") return true;
  return $el.parents(`[${COVERED_ATTR}="1"]`).length > 0;
}

/**
 * Mark chrome + primary extraction regions so residual scan ignores them.
 */
function markPrimaryCoveredRegions($, pageType, options = {}) {
  markCoveredRegions($, CHROME_SELECTORS);
  // Collection filter sidebars — never residual-index as FAQ/prose
  if (FACET_SIDEBAR_SELECTORS) {
    markCoveredRegions($, FACET_SIDEBAR_SELECTORS);
  }
  $("script, style, noscript, iframe, svg, template").each((_, el) => {
    $(el).attr(COVERED_ATTR, "1");
  });

  if (pageType === "product") {
    markCoveredRegions($, PRODUCT_PRIMARY_SELECTORS);
    // Title / buy box often sit outside itemtype wrappers
    $("h1").first().attr(COVERED_ATTR, "1");
  } else if (["faq", "blog", "docs"].includes(pageType)) {
    markCoveredRegions($, ARTICLE_PRIMARY_SELECTORS);
  }

  if (options.markFaqCovered) {
    markCoveredRegions($, FAQ_SELECTORS);
  }

  if (Array.isArray(options.extraSelectors) && options.extraSelectors.length) {
    markCoveredRegions($, options.extraSelectors.join(", "));
  }
}

function elementText($, el) {
  return $(el).text().replace(/\s+/g, " ").trim();
}

function headingTextFrom($, el) {
  const $el = $(el);
  const fromHeading = $el
    .find("h1, h2, h3, h4, summary")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();
  if (fromHeading) return fromHeading;

  // Inherit nearest previous heading sibling (common PDP pattern)
  let $prev = $el.prev();
  for (let i = 0; i < 4 && $prev.length; i++) {
    const tag = ($prev.get(0)?.tagName || "").toLowerCase();
    if (/^h[1-4]$/.test(tag)) {
      const t = $prev.text().replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    if (tag === "div" || tag === "section") break;
    $prev = $prev.prev();
  }

  const aria = ($el.attr("aria-label") || "").trim();
  if (aria) return aria;
  const id = ($el.attr("id") || "").replace(/[-_]/g, " ").trim();
  return id || "";
}

function toMarkdown($, el, turndown) {
  const html = $.html(el) || "";
  if (!html.trim()) return "";
  return stripInlineBufferImageContent(
    turndown
      .turndown(html)
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function linkStats($, el) {
  const $el = $(el);
  const links = $el.find("a[href]").toArray();
  const hrefs = [];
  const seen = new Set();
  for (const a of links) {
    const href = ($(a).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    hrefs.push(href);
  }
  const textLen = Math.max(1, elementText($, el).length);
  const linkTextLen = links.reduce(
    (sum, a) => sum + ($(a).text() || "").trim().length,
    0,
  );
  return {
    hrefs,
    linkCount: hrefs.length,
    linkTextRatio: linkTextLen / textLen,
  };
}

/**
 * Link-list / navigation blocks → structured URL attributes only.
 */
function extractLinkListAttributes(heading, hrefs) {
  const attrs = {};
  const h = String(heading || "");
  if (/product|shop|bought|recommend|similar|related/i.test(h)) {
    attrs.related_product_urls = hrefs.slice(0, 40);
  } else {
    attrs.related_urls = hrefs.slice(0, 40);
  }
  return attrs;
}

function isLinkListShape($, el, heading) {
  const stats = linkStats($, el);
  if (stats.linkCount < 2) return false;

  const classId = `${$(el).attr("class") || ""} ${$(el).attr("id") || ""}`;
  if (
    /related|recommend|also-like|similar|complete-the-look|bought-together/i.test(
      classId,
    ) &&
    stats.linkCount >= 2
  ) {
    return true;
  }

  if (LINK_LIST_HEADING_RE.test(heading || "") && stats.linkCount >= 2) {
    return true;
  }
  // Mostly links, little prose
  if (stats.linkTextRatio >= 0.55 && stats.linkCount >= 3) return true;
  const text = elementText($, el);
  if (stats.linkCount >= 4 && text.length < stats.linkCount * 48) return true;
  return false;
}

function schemaHintFromEl($, el) {
  const $el = $(el);
  const itemtype = `${$el.attr("itemtype") || ""} ${$el
    .find("[itemtype]")
    .first()
    .attr("itemtype") || ""}`.toLowerCase();
  if (itemtype.includes("faqpage") || itemtype.includes("question")) {
    return "faq";
  }
  if (itemtype.includes("review") || itemtype.includes("aggregaterating")) {
    return "review";
  }
  if (itemtype.includes("product")) return "product";
  return null;
}

/**
 * Rule-based per-section classification.
 * @returns {{ entity_type, confidence, reason, needsLlm }}
 */
function classifySectionByRules({ heading = "", schemaHint = null, $ = null, el = null } = {}) {
  const candidates = [];
  const h = String(heading || "");

  if (schemaHint === "faq") {
    candidates.push({ entity_type: "faq", weight: 0.95, reason: "schema:faq" });
  } else if (schemaHint === "review") {
    candidates.push({
      entity_type: "review",
      weight: 0.92,
      reason: "schema:review",
    });
  } else if (schemaHint === "product") {
    candidates.push({
      entity_type: "product",
      weight: 0.7,
      reason: "schema:product_block",
    });
  }

  if (FAQ_HEADING_RE.test(h)) {
    candidates.push({ entity_type: "faq", weight: 0.88, reason: "heading:faq" });
  }
  if (REVIEW_HEADING_RE.test(h)) {
    candidates.push({
      entity_type: "review",
      weight: 0.85,
      reason: "heading:review",
    });
  }
  if (POLICY_HEADING_RE.test(h)) {
    candidates.push({
      entity_type: "policy",
      weight: 0.84,
      reason: "heading:policy",
    });
  }
  if (SPECS_HEADING_RE.test(h)) {
    candidates.push({
      entity_type: "general",
      weight: 0.7,
      reason: "heading:specs",
    });
  }

  if ($ && el) {
    const $el = $(el);
    const accordionCount = $el.find("details, [class*='accordion']").length;
    const qaLike =
      $el.find("summary").length >= 2 ||
      ($el.find("dt").length >= 2 && $el.find("dd").length >= 2);
    if ((accordionCount >= 2 || qaLike) && FAQ_HEADING_RE.test(h)) {
      candidates.push({
        entity_type: "faq",
        weight: 0.9,
        reason: "dom:accordion_faq",
      });
    } else if (accordionCount >= 3 && !REVIEW_HEADING_RE.test(h)) {
      candidates.push({
        entity_type: "faq",
        weight: 0.75,
        reason: "dom:accordion",
      });
    }
    if (
      $el.find("[itemprop='review'], [itemprop='reviewRating'], .star, [class*='rating']")
        .length >= 2
    ) {
      candidates.push({
        entity_type: "review",
        weight: 0.78,
        reason: "dom:review",
      });
    }
  }

  if (candidates.length === 0) {
    return {
      entity_type: "general",
      confidence: 0.3,
      reason: "no_section_rule",
      needsLlm: true,
    };
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const best = candidates[0];
  const confidence = clamp01(best.weight);
  return {
    entity_type: normalizeEntityType(best.entity_type),
    confidence,
    reason: best.reason,
    needsLlm: confidence < SECTION_RULE_THRESHOLD,
  };
}

function fingerprintText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when candidate is largely already present in existing section text.
 */
function overlapsExisting(candidateText, existingTexts = []) {
  const cand = fingerprintText(candidateText);
  if (cand.length < MIN_SECTION_CHARS) return true;
  const candTokens = new Set(cand.split(" ").filter((t) => t.length > 3));
  if (candTokens.size < 8) {
    // Short blocks: substring check
    return existingTexts.some((t) => fingerprintText(t).includes(cand.slice(0, 120)));
  }
  for (const existing of existingTexts) {
    const ex = fingerprintText(existing);
    if (!ex) continue;
    let hit = 0;
    for (const tok of candTokens) {
      if (ex.includes(tok)) hit += 1;
    }
    if (hit / candTokens.size >= OVERLAP_SKIP_RATIO) return true;
  }
  return false;
}

function pushCandidate(list, candidate, seenKeys) {
  const key = fingerprintText(
    candidate.heading ||
      candidate.content ||
      (candidate.hrefs || []).join(" ") ||
      candidate.source ||
      `idx-${list.length}`,
  ).slice(0, 160);
  if (!key || seenKeys.has(key)) return;
  if (candidate.content && candidate.content.length < MIN_SECTION_CHARS) {
    // Allow link-list candidates without prose
    if (candidate.shape !== "link_list") return;
  }
  seenKeys.add(key);
  list.push(candidate);
}

/**
 * Collect residual candidate blocks from DOM not marked covered.
 */
function findCandidateSections($, options = {}) {
  const turndown = options.turndown || createTurndown();
  const candidates = [];
  const seenKeys = new Set();
  const seenEls = new Set();

  const considerEl = (el, source) => {
    if (!el || seenEls.has(el)) return;
    if (isInsideCovered($, el)) return;
    // Skip if this node only wraps other covered children
    const $el = $(el);
    if ($el.children().length > 0) {
      const uncoveredKids = $el
        .children()
        .toArray()
        .filter((c) => !isInsideCovered($, c));
      if (uncoveredKids.length === 0) return;
    }

    const text = elementText($, el);
    if (text.length < 40 && $el.find("a[href]").length < 3) return;

    const heading = headingTextFrom($, el);
    const schemaHint = schemaHintFromEl($, el);

    // Drop collection/filter facet chrome (never index as FAQ or related URLs)
    if (
      FACET_HEADING_RE.test(heading) ||
      isFacetFilterBlock($, el, heading, text)
    ) {
      seenEls.add(el);
      $(el).attr(COVERED_ATTR, "1");
      return;
    }

    if (isLinkListShape($, el, heading)) {
      const stats = linkStats($, el);
      seenEls.add(el);
      $(el).attr(COVERED_ATTR, "1");
      // Facet filter link lists are navigation — do not store as related_product_urls
      if (
        FACET_HEADING_RE.test(heading) ||
        /filter|facet|collection|categor/i.test(heading)
      ) {
        return;
      }
      pushCandidate(
        candidates,
        {
          id: `c${candidates.length}`,
          shape: "link_list",
          heading,
          content: "",
          hrefs: stats.hrefs,
          schemaHint,
          source,
        },
        seenKeys,
      );
      return;
    }

    if (text.length < MIN_SECTION_CHARS) return;

    const content = toMarkdown($, el, turndown);
    if (!content || content.length < MIN_SECTION_CHARS) return;

    seenEls.add(el);
    $(el).attr(COVERED_ATTR, "1");
    pushCandidate(
      candidates,
      {
        id: `c${candidates.length}`,
        shape: "prose",
        heading,
        content,
        hrefs: [],
        schemaHint,
        source,
        el,
      },
      seenKeys,
    );
  };

  // Prefer outermost unmatched semantic block
  $(SEMANTIC_SECTION_SELECTORS).each((_, el) => {
    if (candidates.length >= MAX_CANDIDATES) return false;
    if ($(el).parents(SEMANTIC_SECTION_SELECTORS).length > 0) return;
    considerEl(el, "semantic");
  });

  // Heading-adjacent related lists (h2 + following ul) when class is only on the list
  if (candidates.length < MAX_CANDIDATES) {
    $("h2, h3").each((_, headingEl) => {
      if (candidates.length >= MAX_CANDIDATES) return false;
      if (isInsideCovered($, headingEl)) return;
      const heading = $(headingEl).text().replace(/\s+/g, " ").trim();
      if (!LINK_LIST_HEADING_RE.test(heading)) return;
      const $list = $(headingEl).nextAll("ul, ol, div").first();
      if (!$list.length || isInsideCovered($, $list.get(0))) return;
      if (!isLinkListShape($, $list.get(0), heading)) return;
      const stats = linkStats($, $list.get(0));
      $(headingEl).attr(COVERED_ATTR, "1");
      $list.attr(COVERED_ATTR, "1");
      pushCandidate(
        candidates,
        {
          id: `c${candidates.length}`,
          shape: "link_list",
          heading,
          content: "",
          hrefs: stats.hrefs,
          schemaHint: null,
          source: "heading_adjacent_links",
        },
        seenKeys,
      );
    });
  }

  // 2) Heading-bounded sections (h2/h3 + following siblings)
  if (candidates.length < MAX_CANDIDATES) {
    $("h2, h3").each((_, headingEl) => {
      if (candidates.length >= MAX_CANDIDATES) return false;
      if (isInsideCovered($, headingEl)) return;

      const heading = $(headingEl).text().replace(/\s+/g, " ").trim();
      if (!heading || heading.length > 160) return;
      // Skip collection filter headings entirely
      if (FACET_HEADING_RE.test(heading)) {
        $(headingEl).attr(COVERED_ATTR, "1");
        return;
      }

      const tagName = (
        headingEl.tagName ||
        headingEl.name ||
        ""
      ).toLowerCase();
      const level = tagName === "h2" ? 2 : 3;
      const parts = [$.html(headingEl)];
      let $cursor = $(headingEl).next();
      while ($cursor.length) {
        const tag = ($cursor.get(0)?.tagName || "").toLowerCase();
        if (tag === "h1" || tag === "h2") break;
        if (level === 3 && tag === "h3") break;
        // h2 sections include nested h3 blocks until the next h2
        if ($cursor.attr(COVERED_ATTR) === "1") {
          $cursor = $cursor.next();
          continue;
        }
        parts.push($.html($cursor));
        $cursor = $cursor.next();
      }

      const wrapHtml = `<section>${parts.join("")}</section>`;
      const temp$ = cheerio.load(wrapHtml);
      const text = temp$("section").text().replace(/\s+/g, " ").trim();
      if (text.length < MIN_SECTION_CHARS && !LINK_LIST_HEADING_RE.test(heading)) {
        return;
      }

      if (LINK_LIST_HEADING_RE.test(heading) || isLinkListFromHtml(temp$, "section")) {
        const stats = linkStats(temp$, temp$("section").get(0));
        if (stats.linkCount >= 3) {
          pushCandidate(
            candidates,
            {
              id: `c${candidates.length}`,
              shape: "link_list",
              heading,
              content: "",
              hrefs: stats.hrefs,
              schemaHint: null,
              source: "heading_link_list",
            },
            seenKeys,
          );
          $(headingEl).attr(COVERED_ATTR, "1");
          return;
        }
      }

      const content = stripInlineBufferImageContent(
        turndown
          .turndown(wrapHtml)
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
      if (!content || content.length < MIN_SECTION_CHARS) return;

      pushCandidate(
        candidates,
        {
          id: `c${candidates.length}`,
          shape: "prose",
          heading,
          content,
          hrefs: [],
          schemaHint: null,
          source: "heading_block",
        },
        seenKeys,
      );
      $(headingEl).attr(COVERED_ATTR, "1");
    });
  }

  return candidates.slice(0, MAX_CANDIDATES);
}

function isLinkListFromHtml($, selector) {
  const el = $(selector).get(0);
  if (!el) return false;
  return isLinkListShape($, el, headingTextFrom($, el));
}

function mergeAttributes(target = {}, extra = {}) {
  const out = { ...target };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const prev = Array.isArray(out[key]) ? out[key] : [];
      const set = new Set(prev.map(String));
      for (const item of value) {
        const s = String(item);
        if (!set.has(s)) {
          set.add(s);
          prev.push(item);
        }
      }
      out[key] = prev.slice(0, 40);
    } else if (out[key] == null || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

function batchByCharBudget(items, maxChars = MAX_LLM_BATCH_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const len = String(item.content || "").length + String(item.heading || "").length;
    if (current.length && size + len > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Scan page for content outside primary covered regions.
 * Link-lists become page-level attributes; prose becomes extra sections.
 *
 * @returns {Promise<{ sections: object[], pageAttributes: object, stats: object }>}
 */
async function processResidualSections({
  html,
  pageType = "generic",
  existingSections = [],
  markFaqCovered = false,
  extraCoveredSelectors = [],
  deterministicPage = false,
  usageContext = {},
} = {}) {
  const empty = {
    sections: [],
    pageAttributes: {},
    stats: { candidates: 0, linkLists: 0, ruleClassified: 0, llmClassified: 0 },
  };
  if (!html || typeof html !== "string") return empty;

  const $ = cheerio.load(html);
  markPrimaryCoveredRegions($, pageType, {
    markFaqCovered,
    extraSelectors: extraCoveredSelectors,
  });

  const turndown = createTurndown();
  const candidates = findCandidateSections($, { turndown });

  const existingTexts = existingSections
    .map((s) => s.content)
    .filter(Boolean);
  const pageAttributes = {};
  const highConfidence = [];
  const lowConfidence = [];

  for (const cand of candidates) {
    if (cand.shape === "link_list") {
      const attrs = extractLinkListAttributes(cand.heading, cand.hrefs || []);
      Object.assign(pageAttributes, mergeAttributes(pageAttributes, attrs));
      continue;
    }

    if (overlapsExisting(cand.content, existingTexts)) continue;

    const rule = classifySectionByRules({
      heading: cand.heading,
      schemaHint: cand.schemaHint,
      $: cand.el ? $ : null,
      el: cand.el || null,
    });

    const classified = {
      ...cand,
      entity_type: rule.entity_type,
      classification_confidence: rule.confidence,
      classification_reason: rule.reason,
      needsLlm: rule.needsLlm,
    };

    if (rule.needsLlm) lowConfidence.push(classified);
    else highConfidence.push(classified);
  }

  // Batched LLM for ambiguous residual sections (skipped on deterministic pages /
  // when SECTION_LLM_ENABLED is false — classifier records skip stats).
  let llmClassified = [];
  if (lowConfidence.length > 0) {
    // Single capped call — classifySectionsLlm enforces MAX_SECTIONS / MAX_BATCHES
    const llmResults = await classifySectionsLlm({
      pageType,
      sections: lowConfidence.map((s) => ({
        id: s.id,
        heading: s.heading,
        content: s.content,
        ruleGuess: {
          entity_type: s.entity_type,
          confidence: s.classification_confidence,
          reason: s.classification_reason,
        },
      })),
      deterministicPage,
      ...usageContext,
    });

    const byId = new Map(
      (Array.isArray(llmResults) ? llmResults : []).map((r) => [r.id, r]),
    );

    for (const s of lowConfidence) {
      const llm = byId.get(s.id);
      if (llm) {
        llmClassified.push({
          ...s,
          entity_type: normalizeEntityType(llm.entity_type || s.entity_type),
          entity_name: llm.entity_name || s.heading || null,
          search_terms: [],
          attributes: {},
          classification_confidence: clamp01(
            Math.max(
              s.classification_confidence,
              typeof llm.confidence === "number" ? llm.confidence : 0,
            ),
          ),
          classification_reason: [
            s.classification_reason,
            llm.reason || "llm_section",
          ]
            .filter(Boolean)
            .join("+"),
          needsLlm: false,
        });
      } else {
        // Unresolved / LLM skipped → keep rule guess or general with low confidence
        llmClassified.push({
          ...s,
          entity_type: normalizeEntityType(s.entity_type) || "general",
          entity_name: s.heading || null,
          search_terms: [],
          attributes: {},
          classification_confidence: Math.min(s.classification_confidence, 0.45),
          classification_reason: deterministicPage
            ? `${s.classification_reason}+deterministic_no_llm`
            : `${s.classification_reason}+unresolved`,
          needsLlm: false,
        });
      }
    }
  }

  const allProse = [...highConfidence, ...llmClassified];
  const sections = allProse.map((s) => {
    const entity_type = normalizeEntityType(s.entity_type);
    return {
      pageType: pageTypeForEntity(entity_type, pageType),
      entity_type,
      entity_name: s.entity_name || s.heading || null,
      content: s.content,
      attributes:
        s.attributes && typeof s.attributes === "object" ? s.attributes : {},
      search_terms: Array.isArray(s.search_terms) ? s.search_terms : [],
      classification_confidence:
        typeof s.classification_confidence === "number"
          ? s.classification_confidence
          : 0,
      classification_reason: s.classification_reason || "residual_rules",
      extraction_source: `residual:${s.source || "dom"}`,
    };
  });

  return {
    sections,
    pageAttributes,
    stats: {
      candidates: candidates.length,
      linkLists: candidates.filter((c) => c.shape === "link_list").length,
      ruleClassified: highConfidence.length,
      llmClassified: llmClassified.length,
    },
  };
}

module.exports = {
  processResidualSections,
  markCoveredRegions,
  markPrimaryCoveredRegions,
  findCandidateSections,
  classifySectionByRules,
  extractLinkListAttributes,
  isLinkListShape,
  overlapsExisting,
  SECTION_RULE_THRESHOLD,
  MAX_CANDIDATES,
  MIN_SECTION_CHARS,
  COVERED_ATTR,
};
