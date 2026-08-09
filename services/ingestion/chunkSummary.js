/**
 * Per-child chunk summaries for contextual retrieval.
 *
 * - Always compute extractive rule_summary (cheap, deterministic).
 * - Optionally replace with LLM when ENABLE_LLM_CHUNK_SUMMARY=true
 *   and shouldUseLLMSummary(chunk) passes; on failure keep rule summary.
 *
 * Env:
 *   ENABLE_LLM_CHUNK_SUMMARY=true|false  (default false)
 *   OPENAI_CHUNK_SUMMARY_MODEL           (default OPENAI_CONTEXT_SUMMARY_MODEL or gpt-4o-mini)
 */

const DEFAULT_MAX_CHARS = 250;
const DEFAULT_MAX_SENTENCES = 2;

function isEnvEnabled(name, defaultValue = false) {
  const raw = (process.env[name] || "").toLowerCase().trim();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripPrefixNoise(text) {
  return String(text || "")
    .replace(/^\[Page:[^\]]*\]\s*/i, "")
    .replace(/^\[Document Context:[^\]]*\]\s*/i, "")
    .replace(/^\[Section:[^\]]*\]\s*/i, "")
    .replace(/^\[Chunk Summary:[^\]]*\]\s*/i, "")
    .replace(/^\[Product Attrs:[^\]]*\]\s*/i, "")
    .trim();
}

/**
 * Split into sentences without requiring a heavy NLP lib.
 */
function splitSentences(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return [];
  const parts = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  return parts.map((s) => s.trim()).filter((s) => s.length >= 20);
}

function extractBullets(text) {
  const lines = String(text || "").split("\n");
  const bullets = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.+)$/);
    if (m && m[1].trim().length >= 8) bullets.push(m[1].trim());
  }
  return bullets;
}

function extractFaqPair(text) {
  const q = text.match(
    /(?:^|\n)\s*(?:Q(?:uestion)?|FAQ)\s*[:.-]\s*(.+?)(?:\n|$)/i,
  );
  const a = text.match(/(?:^|\n)\s*A(?:nswer)?\s*[:.-]\s*(.+?)(?:\n|$)/i);
  if (q && a) {
    return normalizeWhitespace(`Q: ${q[1]} A: ${a[1]}`);
  }
  return null;
}

/**
 * Extractive / rule-based chunk summary.
 * Prefer FAQ pair → bullets → first meaningful sentences.
 */
function generateRuleBasedChunkSummary(chunkText, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxSentences = options.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const headingPath = options.heading_path || "";
  const raw = stripPrefixNoise(chunkText);
  if (!raw || raw.length < 40) {
    return headingPath
      ? normalizeWhitespace(`Section: ${headingPath}`)
      : "";
  }

  const faq = extractFaqPair(raw);
  if (faq) return faq.slice(0, maxChars);

  const bullets = extractBullets(raw);
  if (bullets.length >= 2) {
    const joined = bullets.slice(0, 3).join("; ");
    const withHeading = headingPath
      ? `${headingPath}: ${joined}`
      : joined;
    return withHeading.slice(0, maxChars);
  }

  const sentences = splitSentences(raw);
  if (!sentences.length) {
    return raw.slice(0, maxChars);
  }

  // Prefer sentences with product/feature keywords when present
  const scored = sentences.map((s) => {
    let score = Math.min(s.length, 200);
    if (
      /\b(include[sd]?|feature[sd]?|made from|designed|provides?|safety|battery|aluminum|shipping|return|warranty|install)\b/i.test(
        s,
      )
    ) {
      score += 40;
    }
    // Avoid markdown heading leftovers in extractive summary
    if (/^#{1,6}\s/.test(s) || /^section:/i.test(s)) score -= 80;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const used = new Set();
  for (const { s } of scored) {
    if (picked.length >= maxSentences) break;
    if (used.has(s)) continue;
    // Skip pure heading lines
    if (/^#{1,6}\s/.test(s.trim())) continue;
    used.add(s);
    picked.push(s);
  }
  // Restore document order
  picked.sort((a, b) => raw.indexOf(a) - raw.indexOf(b));

  let summary = picked.join(" ");
  if (headingPath && !summary.toLowerCase().includes(headingPath.split(" > ").pop().toLowerCase())) {
    summary = `${headingPath} — ${summary}`;
  }
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, maxChars - 1).trim()}…`;
  }
  return summary;
}

/**
 * Skip LLM for thin / low-value chunks (cost guardrail).
 */
function shouldUseLLMSummary(chunk = {}) {
  const text = stripPrefixNoise(chunk.text || chunk);
  const len = text.length;
  if (len < 100) return false;

  const linkOnly =
    (text.match(/https?:\/\//gi) || []).length >= 3 &&
    text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, "").length < 80;
  if (linkOnly) return false;

  // Pure attribute / price lists
  if (
    /^[\s\-]*(?:sku|brand|price|color|size|availability)\b/i.test(text) &&
    len < 280
  ) {
    return false;
  }

  const lines = text.split("\n").filter((l) => l.trim());
  const bulletRatio =
    lines.length > 0
      ? lines.filter((l) => /^\s*[-*•]\s+/.test(l)).length / lines.length
      : 0;
  // Very short bullet-only blocks
  if (bulletRatio > 0.85 && len < 220) return false;

  // Prefer prose / FAQ / specs
  const looksValuable =
    len >= 180 ||
    /\b(Q:|Question:|FAQ|install|shipping|return|warranty|specification|description)\b/i.test(
      text,
    ) ||
    bulletRatio < 0.85;

  return looksValuable;
}

async function generateLLMChunkSummary(chunkText, options = {}) {
  const OpenAI = require("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model =
    process.env.OPENAI_CHUNK_SUMMARY_MODEL ||
    process.env.OPENAI_CONTEXT_SUMMARY_MODEL ||
    "gpt-4o-mini";
  const headingPath = options.heading_path || "";
  const sample = stripPrefixNoise(chunkText).slice(0, 2000);
  if (!sample) return null;

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content:
          "Summarize this document chunk in 1-2 sentences for search retrieval. Focus on what the chunk is about and key facts. Output ONLY the summary.",
      },
      {
        role: "user",
        content: `${headingPath ? `Section: ${headingPath}\n\n` : ""}Chunk:\n${sample}`,
      },
    ],
  });

  const summary = completion?.choices?.[0]?.message?.content;
  return summary && summary.trim() ? summary.trim().slice(0, 300) : null;
}

/**
 * Resolve active summary for one child chunk.
 * @returns {Promise<{ rule_summary: string, summary: string, summary_source: 'rule'|'llm' }>}
 */
async function resolveChunkSummary(chunkText, options = {}) {
  const rule_summary = generateRuleBasedChunkSummary(chunkText, options);
  let summary = rule_summary;
  let summary_source = "rule";

  const llmEnabled = isEnvEnabled("ENABLE_LLM_CHUNK_SUMMARY", false);
  if (
    llmEnabled &&
    shouldUseLLMSummary({ text: chunkText }) &&
    process.env.OPENAI_API_KEY
  ) {
    try {
      const llm = await generateLLMChunkSummary(chunkText, options);
      if (llm) {
        summary = llm;
        summary_source = "llm";
      }
    } catch (err) {
      console.warn(
        `[chunkSummary] LLM failed, keeping rule summary: ${err.message}`,
      );
    }
  }

  return { rule_summary, summary, summary_source };
}

/**
 * Enrich many children; optional concurrency limit for LLM mode.
 */
async function enrichChunksWithSummaries(chunks, options = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const concurrency = Math.max(
    1,
    Number(process.env.CHUNK_SUMMARY_LLM_CONCURRENCY) || 3,
  );
  const llmEnabled = isEnvEnabled("ENABLE_LLM_CHUNK_SUMMARY", false);

  // Fast path: rule-only (default)
  if (!llmEnabled) {
    return list.map((chunk) => {
      const resolved = {
        rule_summary: generateRuleBasedChunkSummary(chunk.text, {
          heading_path: chunk.heading_path,
          maxChars: options.maxChars,
          maxSentences: options.maxSentences,
        }),
      };
      resolved.summary = resolved.rule_summary;
      resolved.summary_source = "rule";
      return { ...chunk, ...resolved };
    });
  }

  const out = new Array(list.length);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i;
      i += 1;
      const chunk = list[idx];
      const resolved = await resolveChunkSummary(chunk.text, {
        heading_path: chunk.heading_path,
        maxChars: options.maxChars,
        maxSentences: options.maxSentences,
      });
      out[idx] = { ...chunk, ...resolved };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, () => worker()),
  );
  return out;
}

module.exports = {
  generateRuleBasedChunkSummary,
  shouldUseLLMSummary,
  generateLLMChunkSummary,
  resolveChunkSummary,
  enrichChunksWithSummaries,
  isEnvEnabled,
};
