/**
 * Stage E: Generate Contextual Summary (Anthropic-style Contextual Method).
 * Constructs rich, site-agnostic document context header for parent/child chunks.
 *
 * Optional LLM summary when ENABLE_LLM_CONTEXTUAL_SUMMARY=true (uses OpenAI).
 *
 * @param {object} normalizedData - Normalized page data
 * @param {object} [options]       - Additional options
 * @returns {Promise<string>}      - Metadata context header string
 */
async function generateContextualSummary(normalizedData, options = {}) {
  const { pageTitle, pageType, url, headers = [], rawText = "" } =
    normalizedData || {};
  const title = pageTitle && pageTitle !== "Untitled Page" ? pageTitle : "Page";
  const typeLabel = pageType ? String(pageType).replace(/_/g, " ") : "document";

  const mainHeadings = (headers || [])
    .slice(0, 5)
    .map((h) => h.text)
    .filter(Boolean)
    .join(" > ");

  let contextHeader = `Document Title: ${title} | Page Type: ${typeLabel}${
    url ? ` | URL: ${url}` : ""
  }`;
  if (mainHeadings) {
    contextHeader += ` | Topics: ${mainHeadings}`;
  }

  if (
    (process.env.ENABLE_LLM_CONTEXTUAL_SUMMARY || "").toLowerCase() ===
      "true" &&
    rawText
  ) {
    try {
      const OpenAI = require("openai");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const textSample =
        rawText.length > 3000 ? `${rawText.slice(0, 3000)}...` : rawText;
      const prompt = `Page Title: ${title}\nPage URL: ${url}\nPage Type: ${typeLabel}\n\nDocument Snippet:\n${textSample}`;
      const systemInstruction = `You are an AI summarizer implementing Anthropic's Contextual Retrieval method. Give a 1-2 sentence contextual overview of what this document is about and its main purpose. Output ONLY the summary text.`;

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_CONTEXT_SUMMARY_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 100,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: prompt },
        ],
      });

      const summary = completion?.choices?.[0]?.message?.content;
      if (summary && summary.trim()) {
        return `${contextHeader}\nSummary: ${summary.trim()}`;
      }
    } catch (err) {
      console.warn(
        `LLM Contextual Summary failed for ${url}, using structured header:`,
        err.message,
      );
    }
  }

  return contextHeader;
}

module.exports = { generateContextualSummary };
