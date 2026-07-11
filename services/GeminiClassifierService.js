require("dotenv").config();
const axios = require("axios");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

/**
 * Call Gemini API to classify the webpage content and extract structured attributes.
 * 
 * @param {Object} params
 * @param {string} params.content - Refined Markdown text of the page
 * @param {string|null} params.schemaType - Schema.org type detected upstream (if any)
 * @param {string} params.url - Page URL
 * @returns {Promise<Object>} Strictly matching the classification schema
 */
async function classifyContent({ content, schemaType, url }) {
  if (!GEMINI_API_KEY) {
    console.warn("[GeminiClassifier] GEMINI_API_KEY is not defined. Using local fallback classification.");
    return generateFallbackClassification({ content, schemaType, url });
  }

  // Pre-calculate snippet to avoid hitting token limits
  const cleanSnippet = (content || "").substring(0, 15000); // Send up to ~15k chars for safety

  const systemInstructions = `You are a web classifier for a multi-tenant website chatbot platform.
Given the page content, URL, and detected schema.org metadata signals, classify the page and extract key attributes.

Return ONLY a valid JSON object matching this schema:
{
  "entity_type": "product" | "listing" | "faq" | "job_posting" | "service" | "blog_post" | "policy" | "docs" | "about" | "general",
  "entity_name": "string (product name, listing title, job title, service name, or null)",
  "search_terms": ["array of strings — synonyms, alternate names, or common search queries for this content"],
  "attributes": {
    "price": "number (if applicable and filterable)",
    "sizes": ["array of size string options if applicable"],
    "collections": ["array of product collection names if applicable"],
    "bedrooms": "number (if real estate listing)",
    "salary_range": "string (if job listing)"
  },
  "classification_confidence": "float between 0.0 and 1.0",
  "classification_reason": "string (brief justification)"
}

Rules:
1. Base entity_type on the actual content, not just the URL.
2. If schemaType is provided, weight classification_confidence higher (0.9+) and reference it in classification_reason.
3. attributes should only include fields actually present in the content — do not invent values. Price must be a number (float/int).
4. If content is ambiguous, pick the dominant type and lower the confidence.`;

  const prompt = `Page URL: ${url}
Detected Schema Type: ${schemaType || "None"}

Page content:
${cleanSnippet}`;

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await axios.post(
      endpoint,
      {
        contents: [
          {
            parts: [
              {
                text: `${systemInstructions}\n\nInput Page:\n${prompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      },
      {
        timeout: 10000,
      }
    );

    const resultText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) {
      throw new Error("Empty response from Gemini API");
    }

    const parsedJson = JSON.parse(resultText.trim());
    
    // Validate output format & defaults
    const finalResult = {
      entity_type: parsedJson.entity_type || "general",
      entity_name: parsedJson.entity_name || null,
      search_terms: Array.isArray(parsedJson.search_terms) ? parsedJson.search_terms : [],
      attributes: typeof parsedJson.attributes === "object" ? parsedJson.attributes : {},
      classification_confidence: parseFloat(parsedJson.classification_confidence) || 0.5,
      classification_reason: parsedJson.classification_reason || "Gemini classification",
    };

    return finalResult;
  } catch (error) {
    console.error(`[GeminiClassifier] API request failed: ${error.message}. Returning fallback.`);
    return generateFallbackClassification({ content, schemaType, url });
  }
}

/**
 * Local heuristic-based fallback classifier in case the Gemini API is offline or key is missing.
 */
function generateFallbackClassification({ content, schemaType, url }) {
  const { detectContentType } = require("../utils/contentTypeDetector");
  const cheerio = require("cheerio");
  
  const $ = cheerio.load(`<p>${content}</p>`);
  const detection = detectContentType($, url);
  
  const result = {
    entity_type: detection.entityType,
    entity_name: null,
    search_terms: [],
    attributes: {},
    classification_confidence: detection.confidence,
    classification_reason: `${detection.reason} (Fallback classifier)`,
  };

  // Basic attribute extraction for products in fallback
  if (detection.entityType === "product") {
    const priceMatch = content.match(/\$\s*(\d+(?:\.\d{2})?)/);
    if (priceMatch) {
      result.attributes.price = parseFloat(priceMatch[1]);
    }
    
    const titleMatch = content.match(/^#+\s+(.+)$/m) || content.match(/^(.+)$/m);
    if (titleMatch) {
      result.entity_name = titleMatch[1].trim();
    }
  }

  return result;
}

module.exports = {
  classifyContent,
  generateFallbackClassification,
};
