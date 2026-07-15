/**
 * Deterministic page content-type detection.
 * Signal priority: schema.org/JSON-LD → URL pattern → DOM heuristics → generic.
 */

const ENTITY_TYPES = [
  "product",
  "listing",
  "faq",
  "job_posting",
  "service",
  "blog_post",
  "policy",
  "docs",
  "about",
  "general",
];

const SOURCE_TYPES = [
  "html_crawl",
  "pdf",
  "api_feed",
  "manual_upload",
  "revised_answer",
];

/** schema.org @type (lowercased) → entity_type */
const SCHEMA_TO_ENTITY = {
  product: "product",
  individualproduct: "product",
  productmodel: "product",
  someproducts: "product",
  offer: "product",
  aggregateoffer: "product",
  faqpage: "faq",
  question: "faq",
  jobposting: "job_posting",
  realestatelisting: "listing",
  residence: "listing",
  apartment: "listing",
  house: "listing",
  singlefamilyresidence: "listing",
  accommodation: "listing",
  service: "service",
  blogposting: "blog_post",
  blog: "blog_post",
  article: "blog_post",
  newsarticle: "blog_post",
  techarticle: "docs",
  howto: "docs",
  aboutpage: "about",
  contactpage: "about",
  webpage: null,
  organization: null,
  website: null,
  breadcrumblist: null,
};

const URL_PATTERNS = [
  { re: /\/products?\/|\/shop\/|\/item\/|\/p\/|\/catalog\//i, entity: "product", conf: 0.75 },
  { re: /\/collections?\/|\/category\/|\/categories\//i, entity: "product", conf: 0.65 },
  { re: /\/listings?\/|\/property\/|\/properties\/|\/homes?\//i, entity: "listing", conf: 0.75 },
  { re: /\/jobs?\/|\/careers?\/|\/vacancies?\//i, entity: "job_posting", conf: 0.75 },
  { re: /\/faq|\/help\/|\/support\/faq/i, entity: "faq", conf: 0.8 },
  { re: /\/docs?\/|\/documentation\/|\/api\/|\/developers?\//i, entity: "docs", conf: 0.75 },
  { re: /\/blog\/|\/posts?\/|\/articles?\//i, entity: "blog_post", conf: 0.7 },
  { re: /\/privacy|\/terms|\/refund|\/shipping-policy|\/cookie-policy|\/legal\//i, entity: "policy", conf: 0.8 },
  { re: /\/about|\/our-story|\/company|\/contact/i, entity: "about", conf: 0.7 },
  { re: /\/services?\/|\/solutions?\//i, entity: "service", conf: 0.65 },
];

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeEntityType(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (ENTITY_TYPES.includes(v)) return v;
  const aliases = {
    contact: "about",
    contact_info: "about",
    page: "general",
    webpage: "general",
    real_estate: "listing",
    realestate: "listing",
    job: "job_posting",
    career: "job_posting",
    documentation: "docs",
    blog: "blog_post",
  };
  return aliases[v] && ENTITY_TYPES.includes(aliases[v]) ? aliases[v] : null;
}

function normalizeSourceType(raw, fallback = "html_crawl") {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (SOURCE_TYPES.includes(v)) return v;
  const aliases = {
    webpage: "html_crawl",
    crawl: "html_crawl",
    html: "html_crawl",
    scrape: "html_crawl",
    file: "manual_upload",
    snippet: "manual_upload",
    upload: "manual_upload",
  };
  return aliases[v] || fallback;
}

/**
 * Collect schema.org @type values from HTML via cheerio, or from a raw html string.
 * @param {object|null} $ - cheerio instance
 * @param {string} [html]
 * @returns {string[]} lowercased types
 */
function extractSchemaTypes($, html) {
  const types = [];
  const collect = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object") return;
    const t = node["@type"];
    if (typeof t === "string") types.push(t.toLowerCase());
    else if (Array.isArray(t)) {
      t.forEach((x) => typeof x === "string" && types.push(x.toLowerCase()));
    }
    if (node["@graph"]) collect(node["@graph"]);
  };

  try {
    if ($ && typeof $ === "function") {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          collect(JSON.parse($(el).contents().text() || $(el).text() || "{}"));
        } catch (_) {
          /* ignore bad JSON-LD */
        }
      });
    } else if (html && typeof html === "string") {
      const matches = html.matchAll(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      );
      for (const m of matches) {
        try {
          collect(JSON.parse(m[1] || "{}"));
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* ignore */
  }

  return [...new Set(types)];
}

function detectFromSchema(schemaTypes = []) {
  for (const raw of schemaTypes) {
    const key = String(raw || "").toLowerCase();
    const mapped = SCHEMA_TO_ENTITY[key];
    if (mapped) {
      return {
        entity_type: mapped,
        confidence: 0.92,
        signal: "schema",
        reason: `schema.org type "${raw}"`,
        schema_types: schemaTypes,
      };
    }
  }
  return null;
}

function detectFromUrl(url = "") {
  for (const { re, entity, conf } of URL_PATTERNS) {
    if (re.test(url)) {
      return {
        entity_type: entity,
        confidence: conf,
        signal: "url",
        reason: `URL pattern matched ${re}`,
        schema_types: [],
      };
    }
  }
  return null;
}

/**
 * Lightweight DOM / markdown heuristics when schema + URL are weak.
 */
function detectFromDomHeuristics({ html = "", text = "", $ = null } = {}) {
  const body = `${html}\n${text}`.toLowerCase();

  const accordionCount =
    (html.match(/<details[\s>]/gi) || []).length +
    (html.match(/<summary[\s>]/gi) || []).length +
    (text.match(/^#{1,3}\s+.+\n[\s\S]{0,80}\?/gm) || []).length;

  const hasFaqCue =
    /\bfaq\b|\bfrequently asked\b|\bq\s*&\s*a\b/i.test(body) ||
    accordionCount >= 3;

  const priceHits = (
    body.match(
      /(?:\$|€|£|₹)\s?\d[\d,]*(?:\.\d{2})?|\b\d+(?:\.\d{2})?\s*(?:usd|eur|gbp|inr)\b/gi,
    ) || []
  ).length;

  const productCue =
    /\badd to cart\b|\bbuy now\b|\bsku\b|\bin stock\b|\bout of stock\b|\bsize guide\b/i.test(
      body,
    ) ||
    (priceHits >= 2 &&
      /\b(product|item|price|shipping)\b/i.test(body));

  const jobCue =
    /\bapply now\b|\bjob description\b|\bsalary\b|\bfull[- ]time\b|\bpart[- ]time\b|\brequirements\b/i.test(
      body,
    );

  const listingCue =
    /\bbedrooms?\b|\bbathrooms?\b|\bsq\.?\s*ft\b|\bfor sale\b|\bfor rent\b|\bmortgage\b/i.test(
      body,
    );

  const policyCue =
    /\bprivacy policy\b|\bterms of (?:service|use)\b|\brefund policy\b|\bcookie policy\b/i.test(
      body,
    );

  const aboutCue =
    /\babout us\b|\bour story\b|\bcontact us\b|\bphone\b.*\bemail\b/i.test(body);

  let cardish = 0;
  if ($) {
    try {
      cardish = $("[class*='product'], [class*='card'], [data-product]").length;
    } catch (_) {
      cardish = 0;
    }
  }

  if (hasFaqCue) {
    return {
      entity_type: "faq",
      confidence: 0.45,
      signal: "dom",
      reason: "FAQ/accordion heuristics",
      schema_types: [],
    };
  }
  if (jobCue) {
    return {
      entity_type: "job_posting",
      confidence: 0.4,
      signal: "dom",
      reason: "Job posting language heuristics",
      schema_types: [],
    };
  }
  if (listingCue) {
    return {
      entity_type: "listing",
      confidence: 0.4,
      signal: "dom",
      reason: "Real-estate listing heuristics",
      schema_types: [],
    };
  }
  if (productCue || cardish >= 4) {
    return {
      entity_type: "product",
      confidence: productCue ? 0.45 : 0.35,
      signal: "dom",
      reason: productCue
        ? "Product commerce heuristics"
        : "Repeated card/product DOM structures",
      schema_types: [],
    };
  }
  if (policyCue) {
    return {
      entity_type: "policy",
      confidence: 0.45,
      signal: "dom",
      reason: "Policy page language heuristics",
      schema_types: [],
    };
  }
  if (aboutCue) {
    return {
      entity_type: "about",
      confidence: 0.35,
      signal: "dom",
      reason: "About/contact language heuristics",
      schema_types: [],
    };
  }

  return null;
}

/**
 * @param {{
 *   url?: string,
 *   title?: string,
 *   html?: string,
 *   text?: string,
 *   $?: object|null,
 *   schemaTypes?: string[],
 *   metadataType?: string,
 * }} input
 */
function detectContentType(input = {}) {
  const {
    url = "",
    title = "",
    html = "",
    text = "",
    $ = null,
    schemaTypes: providedSchema = null,
    metadataType = "",
  } = input;

  // Manual FAQ uploads are already typed
  if (String(metadataType).toLowerCase() === "faq") {
    return {
      entity_type: "faq",
      confidence: 0.95,
      signal: "metadata",
      reason: "Training item typed as FAQ",
      schema_types: [],
    };
  }

  // check schema.org types first, if present
  const schemaTypes =
    Array.isArray(providedSchema) && providedSchema.length
      ? providedSchema
      : extractSchemaTypes($, html);

  const fromSchema = detectFromSchema(schemaTypes);
  if (fromSchema) return fromSchema;


  // from url checking --> 

  const fromUrl = detectFromUrl(url);
  if (fromUrl) {
    return { ...fromUrl, schema_types: schemaTypes };
  }

  // check DOM heuristics (or markdown text) as a fallback
  
  const fromDom = detectFromDomHeuristics({ html, text: `${title}\n${text}`, $ });
  if (fromDom) {
    return { ...fromDom, schema_types: schemaTypes };
  }

  return {
    entity_type: "general",
    confidence: 0.35,
    signal: "fallback",
    reason: "No schema/URL/DOM signal; defaulting to general content page",
    schema_types: schemaTypes,
  };
}

/**
 * Infer provenance source_type from training metadata.type / mime.
 */
function inferSourceTypeFromMetadata(metadata = {}) {
  const t = String(metadata.type || "").toLowerCase();
  const fileName = String(metadata.fileName || metadata.title || "").toLowerCase();
  if (t === "webpage") return "html_crawl";
  if (t === "faq" || t === "snippet") return "manual_upload";
  if (t === "file") {
    if (fileName.endsWith(".pdf") || metadata.mimeType === "application/pdf") {
      return "pdf";
    }
    return "manual_upload";
  }
  if (metadata.source_type) return normalizeSourceType(metadata.source_type);
  return "html_crawl";
}

/**
 * Map entity_type → retrieval route bias used at query time.
 */
function entityTypeRetrievalBias(entityType) {
  switch (normalizeEntityType(entityType)) {
    case "product":
    case "listing":
      return "catalog";
    case "faq":
    case "docs":
    case "policy":
      return "semantic";
    case "about":
      return "contact";
    case "job_posting":
    case "service":
    case "blog_post":
      return "semantic";
    default:
      return "semantic";
  }
}

/**
 * Calibrate final confidence from detection signal + optional LLM score.
 */
function calibrateClassificationConfidence(detection, llmConfidence = null) {
  const signal = detection?.signal || "fallback";
  let baseline;
  if (signal === "schema" || signal === "metadata") baseline = 0.9;
  else if (signal === "url") baseline = 0.7;
  else if (signal === "dom") baseline = 0.45;
  else baseline = 0.35;

  if (typeof llmConfidence === "number") {
    // Blend: signal baseline anchors the score; LLM nudges within band
    const blended = baseline * 0.6 + clamp01(llmConfidence) * 0.4;
    if (signal === "schema" || signal === "metadata") {
      return clamp01(Math.max(0.9, blended));
    }
    if (signal === "url") return clamp01(Math.min(0.85, Math.max(0.6, blended)));
    if (signal === "dom") return clamp01(Math.min(0.55, Math.max(0.3, blended)));
    return clamp01(Math.min(0.5, Math.max(0.3, blended)));
  }

  return clamp01(baseline);
}

module.exports = {
  ENTITY_TYPES,
  SOURCE_TYPES,
  SCHEMA_TO_ENTITY,
  detectContentType,
  extractSchemaTypes,
  normalizeEntityType,
  normalizeSourceType,
  inferSourceTypeFromMetadata,
  entityTypeRetrievalBias,
  calibrateClassificationConfidence,
};
