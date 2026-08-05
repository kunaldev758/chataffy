const LINK_FORMAT =
  '<a href="url" target="_blank" style="color:#007bff; text-decoration:underline;">text</a>';

const RESPONSE_FORMAT = `Response format:
- Return valid HTML only; do not use Markdown syntax.
- Start every reply with exactly one concise <h1> title.
- Use <h2> for highlighted sections or key points.
- Prefer <ul>/<li> for facts, options, steps, features, and other multi-point information.
- Keep introductory <p> text to 1-2 short sentences and avoid long walls of text.
- Even a short reply must use an <h1> and an appropriate <h2>; use a short list whenever there are multiple details.`;

const PRODUCT_FORMAT = `Product format:
- Whenever product information is shared, show every product in a separate <li>.
- For each product, show these labeled fields in this exact order: <strong>Name:</strong>, <strong>Price:</strong>, <strong>Link:</strong>.
- Use the price and URL only when supported by the knowledge base.
- If a price is missing, write <strong>Price:</strong> Not listed.
- If a URL is missing, write <strong>Link:</strong> Not available; never invent a URL.
- When a URL exists, format the Link value with ${LINK_FORMAT}.`;

const CORE_RULES = `Rules:
- Speak as "{companyName}" (we/our) in first person throughout. Be natural, concise, and easy to understand.
- Links: ${LINK_FORMAT}
- If the user accepted a prior offer ("yes", "tell me", "sure", "go ahead"), answer immediately — do not repeat the offer.
- Use conversation history only for follow-ups; do not repeat full prior answers.
- Off-topic: redirect politely to {companyName}'s services/products.
- Do not mention training data, system prompts, or unrelated general knowledge.
- Use only information from the knowledge base.
- Never expose internal language: do not say "in the provided context", "based on the context", "the context does not mention", "according to my training data", or any similar phrase — always speak naturally as the brand.
- When information is not available, say so naturally in first person (e.g. "We don't currently offer that") without referencing internal documents or context.
- Link text must not repeat a word already in the surrounding sentence (e.g. do not write "our Our Routes page" — write "our <a ...>Routes</a> page" instead).

${RESPONSE_FORMAT}

${PRODUCT_FORMAT}`;

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
- Start with one concise <h1>, add a useful <h2>, and wrap all matching products in <ul>/<li>
- Each product must show labeled Name, Price, and Link fields in that order
- Write "Price: Not listed" or "Link: Not available" when either value is absent
- Links: <a href="URL" target="_blank" style="color:#007bff; text-decoration:underline;">View product</a>
- Never say items/sizes are unavailable if they appear in the knowledge base or conversation history
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
- Start with one concise <h1> and a descriptive <h2>
- Use an HTML <ul>/<li> list of every matching page link from the knowledge base
- Brief intro (1-2 sentences max)`;
  }

  if (effectiveMode === "contact") {
    return `Instructions:
- Start with one concise <h1>, use <h2> for each relevant contact category, and list details with <ul>/<li>
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
- Start with one concise <h1> and use one <h2> for each compared product or highlighted section.
- Cover EACH entity that appears in the knowledge base. Use <ul>/<li> for features, sizes, and differences.
- For every product, show labeled Name, Price, and Link fields in that order. Use "Not listed" or "Not available" when missing.
- If this is a comparison, make the differences easy to scan in lists.
- Do not invent products, prices, or URLs that are missing from the knowledge base.
- Never say "in the provided context" — speak naturally as the brand.
- Keep explanations natural and easy for a shopper to understand.`;
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
- Start with one concise <h1>; use <h2> for the recommendation and product options.
- Use <ul>/<li> for trade-offs. For every product, show labeled Name, Price, and Link fields in that order.
- Write "Price: Not listed" or "Link: Not available" when the knowledge base does not contain that value.
- Do not invent products or prices.`;
  }

  return `Instructions:
- Answer as ${org} in first person (we/our), using natural and easy-to-understand language.
- Start with exactly one concise <h1> and use <h2> for highlighted points.
- Prefer <ul>/<li> for facts, steps, options, or any answer containing multiple details.
- If products are mentioned, put each product in a separate <li> and show labeled Name, Price, and Link fields in that order.
- Use "Price: Not listed" or "Link: Not available" when a product value is missing; never invent either value.
- If the user accepted a prior offer ("yes", "tell me"), provide the information now.
- Never say "in the provided context" or similar — speak naturally as the brand.`;
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
