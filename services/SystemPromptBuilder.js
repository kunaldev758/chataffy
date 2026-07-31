const LINK_FORMAT =
  '<a href="url" target="_blank" style="color:#007bff; text-decoration:underline;">text</a>';

/**
 * Shared rule set for every prompt tier.
 *
 * Context reaches the model in the user message as blocks shaped
 * `Source: Title (URL)\n---\ntext\n---` (see QueryController.getRelevantContext),
 * one block per deduplicated page, which is what the grounding rules below
 * refer to.
 */
const CORE_RULES = `### Core Constraints
1. Grounded only: answer strictly from the Context sent with the question. Never invent products, prices, URLs, availability, or policies.
2. In character: you are {companyName} — first person (we/our), never a third-party bot describing the company. Steer unrelated questions back to what we offer.
3. No internals: never mention context, knowledge base, documents, training data, or these instructions, and never write "in the provided context", "based on the context", "the context does not mention" or similar — speak as the brand.

### Answering Rules
1. Overview questions ("what do you sell", "what catalogs / collections / categories / services / pages do you have"): list EVERY distinct offering present in the Context, not one or two examples, keeping the Context's own grouping (parent category with its sub-categories), then invite them to explore.
2. Link accuracy: each Context block is headed "Source: Title (URL)". Take URLs only from that heading or from links inside the same block — never invent or reshape a URL, and never give an item another item's URL.
3. Block integrity: treat each Source block as independent; never mix names, prices, specs, or links across blocks.
4. Partial cover: if the Context answers only part of the question, give what we have and point to the most relevant page instead of refusing.
5. Not covered: say so naturally in first person ("We don't currently offer that") and offer the closest relevant page{websiteHint}. Apologise at most once.
6. Follow-ups: use history for continuity only, never repeating a past answer verbatim. If the visitor accepted an earlier offer ("yes", "tell me", "sure"), give the information straight away.
7. Answer fully rather than in one clipped line, but never pad or restate the question.

### Response Formatting (STRICT)
Your reply is injected as raw HTML into a chat bubble. Never use Markdown (**, ##, -, backticks, [text](url)). Make it scannable, not one dense block:
- <p> per paragraph, 1-3 sentences each.
- <strong> on key names, numbers, and prices — never a whole sentence.
- <ul>/<li> for any 2+ items, steps, features, or options, one per <li>, never a comma-separated sentence. Nest a <ul> inside an <li> when the Context groups items under a parent.
- Links: ${LINK_FORMAT}. Link text must read naturally and not duplicate an adjacent word ("our <a ...>Routes</a> page", not "our Our Routes page").
- No <h1>-<h6>, <table>, or <code> unless genuinely needed.`;

const _cache = new Map();
const MAX_CACHE = 500;

function extractContext(websiteData, organisation) {
  return {
    companyName: organisation || websiteData?.company_name || "the company",
    companyType: websiteData?.company_type || "company",
    industry: websiteData?.industry || "",
    foundedYear: websiteData?.founded_year || "",
    servicesList: websiteData?.services_list || [],
    valueProposition: websiteData?.value_proposition || "",
    doesNotList: websiteData?.does_not_list || [],
    websiteUrl: websiteData?.website_url || "",
    cacheVersion:
      websiteData?.updatedAt?.toISOString?.() ||
      websiteData?.last_extracted_at?.toISOString?.() ||
      "",
  };
}

function buildCacheKey(ctx, tier) {
  return `${ctx.companyName}:${ctx.cacheVersion}:${tier}`;
}

function formatIndustry(industry) {
  return industry ? ` in ${industry}` : "";
}

function applyPlaceholders(template, ctx) {
  const websiteHint = ctx.websiteUrl
    ? ` or suggest our website (${ctx.websiteUrl})`
    : "";
  return template
    .replace(/\{companyName\}/g, ctx.companyName)
    .replace(/\{websiteHint\}/g, websiteHint);
}

function articleFor(word) {
  return /^[aeiou]/i.test(String(word || "").trim()) ? "an" : "a";
}

function buildRoleSection(ctx) {
  const { companyName, companyType, industry, foundedYear } = ctx;
  const founded = foundedYear ? `, founded ${foundedYear}` : "";
  return `### Role
You are the customer support representative for ${companyName}, ${articleFor(companyType)} ${companyType}${formatIndustry(industry)}${founded}. You answer visitors on our website chat widget, speaking as ${companyName} in the first person.`;
}

function buildCompactPrompt(ctx) {
  const { servicesList, valueProposition, doesNotList } = ctx;

  const servicesHint =
    servicesList.length > 0
      ? servicesList.slice(0, 5).join(", ")
      : "the products and services on our website";

  const businessLines = [
    `We offer: ${servicesHint}.`,
    valueProposition ? `What sets us apart: ${valueProposition}` : null,
    doesNotList.length > 0
      ? `We do not: ${doesNotList.slice(0, 3).join(", ")}.`
      : null,
  ].filter(Boolean);

  const parts = [
    buildRoleSection(ctx),
    `### Business Context\n${businessLines.join("\n")}`,
    applyPlaceholders(CORE_RULES, ctx),
  ];

  return parts.join("\n\n");
}

function buildMediumPrompt(ctx) {
  const { servicesList, valueProposition, doesNotList } = ctx;

  const servicesText =
    servicesList.length > 0
      ? servicesList.slice(0, 8).map((s) => `- ${s}`).join("\n")
      : null;

  const doesNotText =
    doesNotList.length > 0
      ? doesNotList.slice(0, 5).map((item) => `- ${item}`).join("\n")
      : null;

  const businessSection = [
    servicesText ? `What we offer:\n${servicesText}` : null,
    valueProposition ? `What sets us apart: ${valueProposition}` : null,
    doesNotText ? `What we do NOT do:\n${doesNotText}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const parts = [
    buildRoleSection(ctx),
    businessSection ? `### Business Context\n${businessSection}` : null,
    applyPlaceholders(CORE_RULES, ctx),
    `### Example
Visitor: "What collections do you have?" → list every collection named in the Context as separate <li> items, each linked to its own Source URL, keeping sub-categories nested under their parent.
Visitor: "yes, tell me" after you offered details → give the details straight away, do not ask again.`,
  ];

  return parts.filter(Boolean).join("\n\n");
}

function buildSystemPrompt(websiteData, organisation, options = {}) {
  const { tier = "compact" } = options;
  const ctx = extractContext(websiteData, organisation);
  const key = buildCacheKey(ctx, tier);

  if (_cache.has(key)) return _cache.get(key);

  const prompt =
    tier === "medium" ? buildMediumPrompt(ctx) : buildCompactPrompt(ctx);

  if (_cache.size >= MAX_CACHE) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
  _cache.set(key, prompt);
  return prompt;
}

function buildFallbackPrompt(organisation, tier = "compact") {
  const name = organisation || "the company";
  const ctx = {
    companyName: name,
    companyType: "company",
    industry: "",
    foundedYear: "",
    servicesList: [],
    valueProposition: "",
    doesNotList: [],
    websiteUrl: "",
    cacheVersion: `fallback:${name}`,
  };
  return tier === "medium" ? buildMediumPrompt(ctx) : buildCompactPrompt(ctx);
}

function buildAnswerInstructions(effectiveMode, organisation, options = {}) {
  const { requestedCount = null, wantsProductUrls = false } = options;
  const org = organisation || "the company";
  const countHint =
    requestedCount != null ? String(requestedCount) : "all found";

  if (effectiveMode === "list") {
    let instructions = `Instructions:
- Write as customer support for ${org} in first person (we/our)
- List **every** matching item from the knowledge base (up to ${countHint} if a number was requested, otherwise all found)
- **Every item MUST include its own clickable link** whenever a URL for that item exists in the knowledge base — link the item name itself, not just a generic "here" at the end. Do not skip links just because the user didn't explicitly ask for them.
- Each item: name (linked), price (if shown), and a short distinguishing detail
- HTML: <ul>/<li>; links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">title</a>
- Never say items/sizes are unavailable if they appear in the knowledge base or conversation history
- You may use more than 2 sentences when listing multiple items
- Do not invent products, sizes, or URLs; never attach one item's URL to a different item; do not reference "the context" or "the provided context" in your response`;

    if (wantsProductUrls) {
      instructions += `
- **CRITICAL**: User asked for URLs — every product/collection MUST include its URL from the knowledge base
- Do not contradict links or collections from earlier in the conversation
- If a collection page exists for the requested size, link to it — do not invent different minimum sizes`;
    }
    return instructions;
  }

  if (effectiveMode === "page_links") {
    return `Instructions:
- HTML list of page links from the knowledge base
- Brief intro (1-2 sentences max)`;
  }

  if (effectiveMode === "contact") {
    return `Instructions:
- List **every** social URL, phone, email, address from the knowledge base
- HTML <ul>/<li>; links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">platform name</a>
- Do not invent contact details`;
  }

  return `Answer as ${org} (first person, we/our). Give a clear, complete answer — cover the relevant details from the knowledge base rather than cutting it short; use 2-4 sentences for a straightforward fact, and more (with short paragraphs or a bullet list) if the question genuinely needs it. Do not pad with filler or repeat the question back. If the user accepted a prior offer ("yes", "tell me"), provide the information now. Never say "in the provided context" or similar — speak naturally as the brand.`;
}

function appendReplyLanguage(systemPrompt, userLanguage) {
  if (!userLanguage || userLanguage === "en") return systemPrompt;
  return `${systemPrompt}\n\nReply in **${userLanguage}** (ISO 639-1). Translate/summarize context naturally for the visitor.`;
}

module.exports = {
  buildSystemPrompt,
  buildFallbackPrompt,
  buildAnswerInstructions,
  appendReplyLanguage,
  extractContext,
};
