const { get_encoding } = require("tiktoken");
const { TextDecoder } = require("util");
const {
  buildHeadingSpans,
  resolveHeadingPathForChunk,
  formatHeadingPath,
} = require("./headingPath");

let tokenizer = null;
function getTokenizer() {
  if (!tokenizer) {
    tokenizer = get_encoding("cl100k_base");
  }
  return tokenizer;
}

/**
 * Counts exact tokens using cl100k_base encoding.
 */
function countTokens(text) {
  if (!text) return 0;
  try {
    const enc = getTokenizer();
    return enc.encode(String(text)).length;
  } catch (_) {
    // Fallback token estimation
    return Math.ceil(String(text).length / 4);
  }
}

/**
 * Last-resort exact token split for indivisible lines/tables/URL walls.
 * This never truncates input and guarantees each returned part fits maxTokens.
 */
function hardSplitByTokens(text, maxTokens) {
  const value = String(text || "").trim();
  if (!value) return [];
  const safeMax = Math.max(1, Number(maxTokens) || 1);
  if (countTokens(value) <= safeMax) return [value];

  try {
    const enc = getTokenizer();
    const tokens = enc.encode(value);
    const decoder = new TextDecoder();
    const parts = [];
    for (let i = 0; i < tokens.length; i += safeMax) {
      const decoded = decoder.decode(enc.decode(tokens.slice(i, i + safeMax))).trim();
      if (decoded) parts.push(decoded);
    }
    return parts;
  } catch (_) {
    // Conservative fallback when tokenizer decode is unavailable.
    const charBudget = Math.max(1, safeMax * 3);
    const parts = [];
    for (let i = 0; i < value.length; i += charBudget) {
      const part = value.slice(i, i + charBudget).trim();
      if (part) parts.push(part);
    }
    return parts;
  }
}

/**
 * Extracts trailing lines from a text chunk up to a maximum token budget for chunk overlap.
 */
function getTrailingOverlap(chunkText, overlapTokens) {
  if (!overlapTokens || overlapTokens <= 0 || !chunkText.trim()) return "";
  const lines = chunkText.trim().split("\n");
  let overlapText = "";
  let overlapCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const lineTokens = countTokens(line);
    if (overlapCount + lineTokens > overlapTokens && overlapText.length > 0) {
      break;
    }
    overlapText = line + "\n" + overlapText;
    overlapCount += lineTokens;
  }
  return overlapText;
}

/**
 * Splits text into chunks by token count using cl100k_base tokenizer.
 * Respects paragraph boundaries and applies sliding window token overlap.
 *
 * @param {string} text          - Input text to split
 * @param {number} maxTokens     - Maximum tokens per chunk
 * @param {number} overlapTokens - Token overlap between consecutive chunks
 * @returns {string[]}           - Array of text chunks
 */
function splitByTokens(text, maxTokens, overlapTokens = 0) {
  if (!text || !text.trim()) return [];

  const totalTokens = countTokens(text);
  if (totalTokens <= maxTokens) {
    return [text.trim()];
  }

  // Split into natural paragraph blocks to prevent cutting product/document cards mid-sentence
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let currentChunk = "";
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = countTokens(para);

    if (paraTokens > maxTokens) {
      if (currentChunk.trim()) {
        const overlap = getTrailingOverlap(currentChunk, overlapTokens);
        chunks.push(currentChunk.trim());
        currentChunk = overlap;
        currentTokens = countTokens(overlap);
      }
      const lines = para.split(/\n/);
      for (const line of lines) {
        const lineTokens = countTokens(line);
        if (currentTokens + lineTokens > maxTokens && currentChunk.trim()) {
          const overlap = getTrailingOverlap(currentChunk, overlapTokens);
          chunks.push(currentChunk.trim());
          currentChunk = (overlap ? overlap : "") + line + "\n";
          currentTokens = countTokens(currentChunk);
        } else {
          currentChunk += line + "\n";
          currentTokens += lineTokens;
        }
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && currentChunk.trim()) {
      const overlap = getTrailingOverlap(currentChunk, overlapTokens);
      chunks.push(currentChunk.trim());
      currentChunk = (overlap ? overlap : "") + para + "\n\n";
      currentTokens = countTokens(currentChunk);
    } else {
      currentChunk += para + "\n\n";
      currentTokens += paraTokens;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Paragraph/line boundaries are preferred above, but one line can itself
  // exceed the budget. Enforce the invariant before returning.
  return chunks.flatMap((chunk) => hardSplitByTokens(chunk, maxTokens));
}

/**
 * Stage G & H: Hierarchical Parent-Child Chunking Strategy.
 *
 * Parent: 850 tokens | Child: 350 tokens | overlap: 50
 * Heading paths are resolved separately (does not change split sizes).
 * contextualText is finalized later in ingestionService (summary + attrs).
 *
 * @returns {{ parentChunks: object[], childChunks: object[], headingSpans: object[] }}
 */
function createParentChildChunks(
  rawText,
  contextualSummary = "",
  metadata = {},
  structures = [],
) {
  const PARENT_TARGET_TOKENS = 850;
  const CHILD_TARGET_TOKENS = 350;
  const CHILD_OVERLAP_TOKENS = 50;

  // Use structural blocks if available, preserving tables and code blocks intact
  let sourceText = rawText;
  if (Array.isArray(structures) && structures.length > 0) {
    sourceText = structures
      .map((block) => {
        if (block.type === "code_block" || block.type === "table") {
          return `\n\n${block.content}\n\n`;
        }
        return block.content;
      })
      .join("\n\n");
  }

  // Heading spans over the same source used for token splits
  const headingSpans = buildHeadingSpans(sourceText);

  const parentRawTexts = splitByTokens(sourceText, PARENT_TARGET_TOKENS, 50);
  const parentChunks = [];
  const childChunks = [];

  parentRawTexts.forEach((pText, pIndex) => {
    const parentId = `parent_${pIndex}_${countTokens(pText)}`;
    const parentHeading = formatHeadingPath(
      resolveHeadingPathForChunk(pText, headingSpans),
    );

    parentChunks.push({
      parentId,
      parentIndex: pIndex,
      text: pText,
      heading_path: parentHeading,
      // Provisional; ingestionService rebuilds child contextualText
      contextualText: pText,
      tokenCount: countTokens(pText),
      ...metadata,
    });

    const childRawTexts = splitByTokens(
      pText,
      CHILD_TARGET_TOKENS,
      CHILD_OVERLAP_TOKENS,
    );

    childRawTexts.forEach((cText, cIndex) => {
      const childHeading = formatHeadingPath(
        resolveHeadingPathForChunk(cText, headingSpans) || parentHeading,
      );

      childChunks.push({
        childIndex: `${pIndex}_${cIndex}`,
        parentId,
        parentText: pText,
        text: cText,
        heading_path: childHeading,
        contextualText: cText,
        tokenCount: countTokens(cText),
        ...metadata,
      });
    });
  });

  return { parentChunks, childChunks, headingSpans };
}

module.exports = {
  countTokens,
  hardSplitByTokens,
  splitByTokens,
  createParentChildChunks,
};
