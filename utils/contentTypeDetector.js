const { URL } = require("url");

/**
 * Maps schema.org JSON-LD types to Chataffy entity types.
 */
const SCHEMA_TYPE_MAP = {
  // Products
  "Product": "product",
  "ProductModel": "product",
  "IndividualProduct": "product",
  "SomeProducts": "product",
  
  // FAQs
  "FAQPage": "faq",
  "QAPage": "faq",
  
  // Job Postings
  "JobPosting": "job_posting",
  
  // Services
  "Service": "service",
  "GovernmentService": "service",
  
  // Blog / Articles
  "BlogPosting": "blog_post",
  "Article": "blog_post",
  "NewsArticle": "blog_post",
  "TechArticle": "docs",
  
  // Policy pages
  "WebPageElement": "general", // generic fallback
  
  // Listings
  "RealEstateListing": "listing",
  "OfferCatalog": "listing",
  "ItemList": "listing",
};

/**
 * Detect content type based on priority signals:
 * 1. JSON-LD schema.org types
 * 2. URL route patterns
 * 3. DOM heuristics
 * 4. Fallback: general (generic)
 * 
 * @param {Object} $ - Cheerio loaded document
 * @param {string} url - Page URL
 * @returns {{ entityType: string, confidence: number, reason: string, schemaType: string|null }}
 */
function detectContentType($, url) {
  let detectedType = null;
  let confidence = 0.3;
  let reason = "Fallback generic classification";
  let detectedSchemaType = null;

  // ─── SIGNAL 1: JSON-LD ──────────────────────────────────────────────────────
  try {
    const jsonLdScripts = $('script[type="application/ld+json"]');
    jsonLdScripts.each((_, script) => {
      try {
        const text = $(script).html();
        if (!text) return;
        const data = JSON.parse(text);
        
        // JSON-LD can be a single object, an array, or a @graph list
        const parseNode = (node) => {
          if (!node || typeof node !== "object") return;
          
          if (node["@type"]) {
            const type = String(node["@type"]);
            if (SCHEMA_TYPE_MAP[type]) {
              detectedType = SCHEMA_TYPE_MAP[type];
              detectedSchemaType = type;
              confidence = 0.95;
              reason = `JSON-LD schema type "${type}" detected`;
              return true;
            }
          }
          
          if (node["@graph"] && Array.isArray(node["@graph"])) {
            for (const subNode of node["@graph"]) {
              if (parseNode(subNode)) return true;
            }
          }
          
          return false;
        };

        if (Array.isArray(data)) {
          for (const item of data) {
            if (parseNode(item)) return false; // Break loop
          }
        } else {
          parseNode(data);
        }
      } catch (e) {
        // Ignore json-ld parse error for specific script tag
      }
    });
  } catch (err) {
    console.warn("[ContentTypeDetector] Error checking JSON-LD:", err.message);
  }

  if (detectedType) {
    return { entityType: detectedType, confidence, reason, schemaType: detectedSchemaType };
  }

  // ─── SIGNAL 2: URL Pattern ──────────────────────────────────────────────────
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.toLowerCase();

    if (/\/products?\b|\/items?\b|\/shop\b|\/catalog\b|\/p\//i.test(path)) {
      return {
        entityType: "product",
        confidence: 0.75,
        reason: `URL path matches product pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/collections?\b|\/categories?\b/i.test(path)) {
      return {
        entityType: "listing",
        confidence: 0.7,
        reason: `URL path matches listing/collection pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/faqs?\b|\/frequently-asked-questions/i.test(path)) {
      return {
        entityType: "faq",
        confidence: 0.8,
        reason: `URL path matches FAQ pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/jobs?\b|\/careers?\b|\/recruitment\b/i.test(path)) {
      return {
        entityType: "job_posting",
        confidence: 0.8,
        reason: `URL path matches job posting pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/blogs?\b|\/articles?\b|\/news\b/i.test(path)) {
      return {
        entityType: "blog_post",
        confidence: 0.75,
        reason: `URL path matches blog/news pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/docs?\b|\/documentation\b|\/help\b|\/guide\b/i.test(path)) {
      return {
        entityType: "docs",
        confidence: 0.75,
        reason: `URL path matches documentation pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/policy\b|\/privacy-policy\b|\/terms-of-service\b|\/tos\b/i.test(path)) {
      return {
        entityType: "policy",
        confidence: 0.8,
        reason: `URL path matches legal/policy pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/about-us\b|\/about\b/i.test(path)) {
      return {
        entityType: "about",
        confidence: 0.8,
        reason: `URL path matches about page pattern: ${path}`,
        schemaType: null,
      };
    }
    if (/\/services?\b/i.test(path)) {
      return {
        entityType: "service",
        confidence: 0.7,
        reason: `URL path matches services pattern: ${path}`,
        schemaType: null,
      };
    }
  } catch (urlErr) {
    // Keep going
  }

  // ─── SIGNAL 3: DOM Heuristics ───────────────────────────────────────────────
  // A) FAQ Page: presence of <details>/<summary> tags or multiple Q&A schemas
  const detailsCount = $("details").length;
  const hasAccordion = detailsCount >= 3;
  if (hasAccordion) {
    return {
      entityType: "faq",
      confidence: 0.65,
      reason: `DOM Heuristic: Found ${detailsCount} details/summary accordions`,
      schemaType: null,
    };
  }

  // B) Product Heuristics: price matching, Add to Cart buttons
  const bodyHtml = $("body").html() || "";
  const hasAddToCart = /add to cart|add to bag|buy now|check out/i.test(bodyHtml);
  const hasPriceClass = $('[class*="price"], [id*="price"]').length > 0;
  const hasDollarSign = /\$\d+(\.\d{2})?/.test(bodyHtml);

  if (hasAddToCart && (hasPriceClass || hasDollarSign)) {
    return {
      entityType: "product",
      confidence: 0.6,
      reason: "DOM Heuristic: Found Add to Cart indicators and price formatting",
      schemaType: null,
    };
  }

  // C) Product listings: repeating cards containing prices or product-looking titles
  const cardElements = $('[class*="card"], [class*="product-item"], [class*="grid-item"]');
  if (cardElements.length >= 4 && hasDollarSign) {
    return {
      entityType: "listing",
      confidence: 0.55,
      reason: `DOM Heuristic: Found repeating card elements (${cardElements.length}) with prices`,
      schemaType: null,
    };
  }

  // D) Blog / Post page: presence of article tag, meta data for published time, etc.
  const hasArticleTag = $("article").length > 0;
  const hasPublishTime = $('meta[property*="published_time"], meta[name*="date"]').length > 0;
  if (hasArticleTag || hasPublishTime) {
    return {
      entityType: "blog_post",
      confidence: 0.55,
      reason: "DOM Heuristic: Page contains article elements or publication metadata",
      schemaType: null,
    };
  }

  // Fallback to generic
  return {
    entityType: "general",
    confidence,
    reason,
    schemaType: null,
  };
}

module.exports = {
  detectContentType,
};
