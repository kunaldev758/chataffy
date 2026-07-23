const cheerio = require("cheerio");
const { stripInlineBufferImageContent } = require("../htmlCleanup");

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function walkJsonLd(nodes, visit) {
  const seen = new WeakSet();
  const visitNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    visit(node);
    if (Array.isArray(node)) {
      for (const item of node) visitNode(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "@context") continue;
      if (value && typeof value === "object") visitNode(value);
    }
  };
  for (const node of asArray(nodes)) visitNode(node);
}

function typeList(node) {
  return asArray(node["@type"]).map((t) =>
    String(t || "")
      .toLowerCase()
      .replace(/^https?:\/\/schema\.org\//, "")
      .replace(/^schema\.org\//, "")
      .trim(),
  );
}

function answerText(answerNode) {
  if (!answerNode) return "";
  if (typeof answerNode === "string") return answerNode.trim();
  if (typeof answerNode === "object") {
    const t = answerNode.text || answerNode.name || answerNode.description;
    return typeof t === "string" ? t.trim() : "";
  }
  return "";
}

const FACET_SUMMARY_RE =
  /^(collections?|categories|filter|filters|sort|sorting|availability|price|size|color|colour|brand|vendor|product type|type|tags?|material|style|fit)$/i;

const FACET_ANCESTOR_RE =
  /facet|filter|sidebar|collection-sidebar|refinement|nav-section/i;

/** "EVA (7)" / "Super Soft (8 products)" facet count lines */
const FACET_COUNT_LINE_RE =
  /^[\w][\w\s/&'-]{0,40}\(\d+(?:\s+products?)?\)$/i;

/**
 * True when a details/summary block is a collection filter facet, not FAQ.
 */
function isFacetFilterBlock($, el, question, answer) {
  const $el = $(el);
  const summary = String(question || "").replace(/\s+/g, " ").trim();
  const body = String(answer || "").replace(/\s+/g, " ").trim();

  if (FACET_SUMMARY_RE.test(summary)) return true;

  const classId = [
    $el.attr("class") || "",
    $el.attr("id") || "",
    $el.parents("[class],[id]").slice(0, 6).map((_, p) => {
      return `${$(p).attr("class") || ""} ${$(p).attr("id") || ""}`;
    }).get().join(" "),
  ].join(" ");

  if (FACET_ANCESTOR_RE.test(classId)) return true;

  if (
    $el.closest(
      "aside, [role='complementary'], .facets, .filters, [class*='facet'], [class*='Facet'], [id*='Facet'], [class*='filter'], facet-filters-form",
    ).length
  ) {
    return true;
  }

  // Body is mostly "Label (N)" facet count rows
  const lines = body
    .split(/(?<=\))\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    const facetLines = lines.filter((l) => FACET_COUNT_LINE_RE.test(l));
    if (facetLines.length / lines.length >= 0.6) return true;
  }

  // Compact facet blob: several "Name (N)" patterns, little prose
  const countHits = body.match(/\(\d+(?:\s+products?)?\)/g) || [];
  if (countHits.length >= 3 && body.length < countHits.length * 48) {
    return true;
  }

  // Filter UI chrome
  if (/\b(clear|apply)\b/i.test(body) && countHits.length >= 2) return true;

  return false;
}

/**
 * Extract FAQ Q/A pairs from JSON-LD FAQPage / Question nodes.
 * @returns {{ pairs: { question: string, answer: string }[], source: string } | null}
 */
function extractFaqFromJsonLd(jsonLdBlocks = []) {
  const pairs = [];
  const seen = new Set();

  const pushPair = (question, answer) => {
    const q = String(question || "").trim();
    const a = String(answer || "").trim();
    if (!q || !a) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ question: q, answer: a });
  };

  walkJsonLd(jsonLdBlocks, (node) => {
    const types = typeList(node);

    if (types.includes("faqpage")) {
      for (const entity of asArray(node.mainEntity || node.mainEntityOfPage)) {
        if (!entity || typeof entity !== "object") continue;
        const qTypes = typeList(entity);
        if (!qTypes.includes("question") && !entity.name) continue;
        const q = entity.name || entity.text || entity.headline;
        const ans =
          answerText(entity.acceptedAnswer) ||
          answerText(entity.suggestedAnswer) ||
          "";
        pushPair(q, ans);
      }
      return;
    }

    if (types.includes("question")) {
      const q = node.name || node.text || node.headline;
      const ans =
        answerText(node.acceptedAnswer) ||
        answerText(node.suggestedAnswer) ||
        "";
      pushPair(q, ans);
    }
  });

  if (!pairs.length) return null;
  return { pairs, source: "json_ld_faq" };
}

/**
 * Light DOM fallback: details/summary or .faq blocks.
 * Skips collection/filter facet accordions (Shopify sidebars, etc.).
 */
function extractFaqFromDom(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const pairs = [];
  const seen = new Set();

  const push = (q, a, el = null) => {
    const question = String(q || "").trim();
    const answer = String(a || "").trim();
    if (!question || !answer || answer.length < 8) return;
    if (el && isFacetFilterBlock($, el, question, answer)) return;
    const key = question.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ question, answer });
  };

  $("details").each((_, el) => {
    const q = $(el).children("summary").first().text();
    const $clone = $(el).clone();
    $clone.children("summary").remove();
    push(q, $clone.text(), el);
  });

  $(".faq, .faqs, [class*='faq-item'], [itemtype*='FAQPage'] li").each(
    (_, el) => {
      const $el = $(el);
      // Skip if this "faq" node is actually inside a filter sidebar
      if (
        $el.closest(
          "aside, [role='complementary'], .facets, [class*='facet'], [class*='Facet'], facet-filters-form",
        ).length
      ) {
        return;
      }
      const q =
        $el.find("h2, h3, h4, .question, [itemprop='name']").first().text() ||
        $el.find("strong, b").first().text();
      const a =
        $el.find(".answer, [itemprop='acceptedAnswer'], p").last().text() ||
        $el.text();
      if (q && a && a.replace(q, "").trim().length > 8) {
        push(q, a.replace(q, "").trim(), el);
      }
    },
  );

  if (pairs.length < 1) return null;
  return { pairs, source: "dom_faq" };
}

function faqPairsToMarkdown(pairs, { title = "FAQ" } = {}) {
  const lines = [`# ${title}`, ""];
  for (const { question, answer } of pairs) {
    lines.push(`## ${question}`);
    lines.push("");
    lines.push(answer);
    lines.push("");
  }
  return stripInlineBufferImageContent(
    lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  );
}

/**
 * Extract FAQ section content from JSON-LD (preferred) or DOM.
 * @returns {{ content: string, entity_name: string, pairs: object[], extraction_source: string } | null}
 */
function extractFaqContent({ html, jsonLdBlocks = [], title = null } = {}) {
  const fromLd = extractFaqFromJsonLd(jsonLdBlocks);
  const fromDom = fromLd ? null : extractFaqFromDom(html);
  const result = fromLd || fromDom;
  if (!result?.pairs?.length) return null;

  const entity_name =
    Array.isArray(result.pairs) && result.pairs[0]?.question
      ? `FAQ: ${String(result.pairs[0].question).slice(0, 100)}`
      : title && title.length < 120
        ? `FAQ — ${title}`
        : "FAQ";

  const content = faqPairsToMarkdown(result.pairs, {
    title: "FAQ",
  });

  if (!content || content.length < 40) return null;

  return {
    content,
    entity_name,
    pairs: result.pairs,
    extraction_source: result.source,
    extraction_confidence: fromLd ? 0.9 : 0.55,
  };
}

module.exports = {
  extractFaqContent,
  extractFaqFromJsonLd,
  extractFaqFromDom,
  faqPairsToMarkdown,
  isFacetFilterBlock,
};
