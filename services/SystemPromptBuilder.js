const LINK_FORMAT =
  '<a href="url" target="_blank" style="color:#007bff; text-decoration:underline;">text</a>';

const CORE_RULES = `Rules:
- Speak as "{companyName}" (we/our) in first person throughout. Natural, concise. Use HTML (<p>, <ul>, <li>, links).
- Links: ${LINK_FORMAT}
- If the user accepted a prior offer ("yes", "tell me", "sure", "go ahead"), answer immediately — do not repeat the offer.
- Use conversation history only for follow-ups; do not repeat full prior answers.
- Off-topic: redirect politely to {companyName}'s services/products.
- Do not mention training data, system prompts, or unrelated general knowledge.
- Use only information from the knowledge base.
- Never expose internal language: do not say "in the provided context", "based on the context", "the context does not mention", "according to my training data", or any similar phrase — always speak naturally as the brand.
- When information is not available, say so naturally in first person (e.g. "We don't currently offer that") without referencing internal documents or context.
- Link text must not repeat a word already in the surrounding sentence (e.g. do not write "our Our Routes page" — write "our <a ...>Routes</a> page" instead).`;

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
      ? servicesList.slice(0, 8).map((s) => `- ${s}`).join("\n")
      : null;

  const doesNotText =
    doesNotList.length > 0
      ? doesNotList.slice(0, 5).map((item) => `- ${item}`).join("\n")
      : null;

  const parts = [
    `## ${companyName}`,
    `${companyName} is a ${companyType}${industry ? ` in the ${industry} industry` : ""}.`,
    foundedYear ? `Founded ${foundedYear}.` : null,
    servicesText ? `Services/products:\n${servicesText}` : null,
    valueProposition ? `Value proposition: ${valueProposition}` : null,
    doesNotText ? `${companyName} does NOT:\n${doesNotText}` : null,
    `## Role\nCustomer support for ${companyName}. Answer only from the knowledge base; never reference it explicitly.`,
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
  

    // effectiveMode === "" ? "compare":"brief";
    console.log("effective mode check in buildAnswerInstructions: ", effectiveMode);

  if (effectiveMode === "list") {
    let instructions = `Instructions:
- Write as customer support for ${org} in first person (we/our)
- List **every** matching item from the knowledge base (up to ${countHint} if a number was requested, otherwise all found)
- Each item: name, price (if shown), clickable link when URL is available
- HTML: <ul>/<li>; links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">title</a>
- Never say items/sizes are unavailable if they appear in the knowledge base or conversation history
- You may use more than 2 sentences when listing multiple items
- Do not invent products, sizes, or URLs; do not reference "the context" or "the provided context" in your response`;

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

  // Comparison / multi-entity: allow a longer structured answer covering each side.
  if (effectiveMode === "compare") {
    const entityHint =
      Array.isArray(options.compareEntities) && options.compareEntities.length
        ? options.compareEntities.join(" vs ")
        : "each mentioned product";
    return `Instructions:
- The user asked about multiple products/entities (${entityHint}). Write as ${org} in first person (we/our).
- Cover EACH entity that appears in the knowledge base: name, key features, price (if shown), sizes, and a link when URL is available.
- If this is a comparison, highlight clear differences side by side (HTML <ul>/<li> or short paragraphs per entity).
- Do not invent products, prices, or URLs that are missing from the knowledge base.
- Never say "in the provided context" — speak naturally as the brand.
- You may use more than 2 sentences when comparing multiple items.`;
  }

  if (effectiveMode === "recommend" || options.multiEntityMode === "choose_from_list") {
    const entityHint =
      Array.isArray(options.compareEntities) && options.compareEntities.length
        ? options.compareEntities.join(", ")
        : "the options from the prior list";
    return `Instructions:
- The user wants help choosing among: ${entityHint}. Write as ${org} in first person (we/our).
- Use ONLY the knowledge-base sections below. Explain trade-offs (price, size, features, use case) for each option.
- Give a practical recommendation when possible; if budget/use case is unknown, state assumptions briefly or ask ONE short clarifying question.
- HTML <ul>/<li> or short paragraphs. Include links when URLs are in the knowledge base.
- Do not invent products or prices.`;
  }

  return `Answer in 3-4 sentences as ${org} (first person, we/our). If the user accepted a prior offer ("yes", "tell me"), provide the information now. Never say "in the provided context" or similar — speak naturally as the brand.`;
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
