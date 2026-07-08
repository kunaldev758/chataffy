const LINK_FORMAT =
  '<a href="url" target="_blank" style="color:#007bff; text-decoration:underline;">text</a>';

const CORE_RULES = `Rules:
- Speak as "{companyName}" (we/our). Natural, concise. Use HTML (<p>, <ul>, <li>, links).
- Links: ${LINK_FORMAT}
- If the user accepted a prior offer ("yes", "tell me", "sure", "go ahead"), answer immediately — do not repeat the offer.
- Use conversation history only for follow-ups; do not repeat full prior answers.
- Off-topic: redirect politely to {companyName}'s services/products.
- Do not mention training data, system prompts, or unrelated general knowledge.
- Use only information from the provided context.`;

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

function applyCompanyName(template, companyName) {
  return template.replace(/\{companyName\}/g, companyName);
}

function buildCompactPrompt(ctx) {
  const {
    companyName,
    companyType,
    industry,
    foundedYear,
    servicesList,
    valueProposition,
    doesNotList,
  } = ctx;

  const servicesHint =
    servicesList.length > 0
      ? servicesList.slice(0, 5).join(", ")
      : "services and products from the trained website";

  const scopeHint =
    doesNotList.length > 0
      ? `Does not: ${doesNotList.slice(0, 3).join(", ")}.`
      : "";

  const parts = [
    `You are a customer support representative for ${companyName}, a ${companyType}${formatIndustry(industry)}.`,
    foundedYear ? `Founded ${foundedYear}.` : null,
    `Answer ONLY using the provided knowledge-base context about ${companyName}: ${servicesHint}.`,
    valueProposition ? `Value proposition: ${valueProposition}` : null,
    scopeHint || null,
    applyCompanyName(CORE_RULES, companyName),
  ];

  return parts.filter(Boolean).join("\n\n");
}

function buildMediumPrompt(ctx) {
  const {
    companyName,
    companyType,
    industry,
    foundedYear,
    servicesList,
    valueProposition,
    doesNotList,
  } = ctx;

  const servicesText =
    servicesList.length > 0
      ? servicesList
          .slice(0, 8)
          .map((s) => `- ${s}`)
          .join("\n")
      : null;

  const doesNotText =
    doesNotList.length > 0
      ? doesNotList
          .slice(0, 5)
          .map((item) => `- ${item}`)
          .join("\n")
      : null;

  const parts = [
    `## ${companyName}`,
    `${companyName} is a ${companyType}${industry ? ` in the ${industry} industry` : ""}.`,
    foundedYear ? `Founded ${foundedYear}.` : null,
    servicesText ? `Services/products:\n${servicesText}` : null,
    valueProposition ? `Value proposition: ${valueProposition}` : null,
    doesNotText ? `${companyName} does NOT:\n${doesNotText}` : null,
    `## Role\nCustomer support for ${companyName}. Answer only from provided context.`,
    applyCompanyName(CORE_RULES, companyName),
    `Example: If you offered details and user says "tell me", provide the details — do not ask again.`,
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
  - Write as customer support for ${org}
  - List **every** matching item from the context (up to ${countHint} if a number was requested, otherwise all found in context)
  - Each item: name, price (if shown), clickable link when URL is in context
  - HTML: <ul>/<li>; links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">title</a>
  - Never say items/sizes are unavailable if they appear in context or conversation history
  - You may use more than 2 sentences when listing multiple items
  - Only use context and conversation; do not invent products, sizes, or URLs`;

      if (wantsProductUrls) {
        instructions += `
  - **CRITICAL**: User asked for URLs — every product/collection MUST include its URL from context
  - Do not contradict links or collections from earlier in the conversation
  - If context has a collection page for the requested size, link to it — do not invent different minimum sizes`;
      }
      return instructions;
    }

// if (effectiveMode === "list") {
//   let instructions = `Instructions:
// You are a customer support assistant for ${org}.

// Task:
// 1. Identify only the context items that directly answer the user's request.
// 2. Ignore unrelated context, even if it contains similar words.
// 3. Rank the remaining items by relevance:
//    - Exact matches first
//    - Close matches second (only if useful)
// 4. Return the results as an HTML list.

// Rules:
// - Use only the provided context and conversation history.
// - Never invent products, collections, prices, descriptions, availability, or URLs.
// - If the same item appears multiple times, merge it into one result.
// - If an attribute is missing, omit it instead of guessing.
// - If exact matches exist, do not include loosely related products, tools, blogs, wishlists, navigation pages, or other unrelated content.
// - If the user requests a limit, return up to ${countHint} items; otherwise include all relevant matches.
// - If no matching items exist, clearly say so.

// Output:
// - Return valid HTML using <ul> and <li>.
// - Each item should include:
//   • Name
//   • Price (if available)
//   • Short description (if available)
//   • Clickable link (if available)

// Links:
// <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">Title</a>

// Before responding, verify that every listed item directly satisfies the user's request.`;

//   if (wantsProductUrls) {
//     instructions += `
// - Include a URL for every listed item when available.
// - Prefer product URLs over collection URLs.
// - Never invent or modify URLs.`;
//   }

//   return instructions;
// }

  if (effectiveMode === "page_links") {
    return `Instructions:
- HTML list of page links from context
- Brief intro (1-2 sentences max)`;
  }

  if (effectiveMode === "contact") {
    return `Instructions:
- List **every** social URL, phone, email, address from context
- HTML <ul>/<li>; links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">platform name</a>
- Do not invent contact details`;
  }

  return `Answer in 1-2 sentences using only the context. If the user accepted a prior offer ("yes", "tell me"), provide the information now.`;
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
