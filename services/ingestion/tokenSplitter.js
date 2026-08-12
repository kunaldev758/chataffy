const { get_encoding } = require("tiktoken");
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
 * Hard-split a single oversized string by character windows until each piece
 * is within maxTokens. Used when one minified line (e.g. Shopify JSON) cannot
 * be split on newlines.
 */
function hardSplitByTokens(text, maxTokens) {
  const raw = String(text || "");
  if (!raw) return [];
  if (countTokens(raw) <= maxTokens) return [raw];

  const pieces = [];
  // Start from a conservative char window (~2.5 chars/token for dense JSON).
  let windowChars = Math.max(64, Math.floor(maxTokens * 2.5));
  let start = 0;
  while (start < raw.length) {
    let end = Math.min(raw.length, start + windowChars);
    let slice = raw.slice(start, end);
    let tokens = countTokens(slice);
    // Shrink quickly if over budget (avoid many tiny encode steps).
    while (tokens > maxTokens && end > start + 16) {
      const ratio = maxTokens / tokens;
      const nextLen = Math.max(16, Math.floor((end - start) * Math.min(0.85, ratio * 0.95)));
      end = start + nextLen;
      slice = raw.slice(start, end);
      tokens = countTokens(slice);
    }
    if (!slice) {
      slice = raw.slice(start, start + 1);
      end = start + 1;
    }
    pieces.push(slice);
    start = end;
  }
  return pieces.filter(Boolean);
}

/**
 * Append text to the current chunk, hard-splitting when a single piece exceeds maxTokens.
 */
function appendWithinTokenBudget({
  chunks,
  currentChunk,
  currentTokens,
  piece,
  maxTokens,
  overlapTokens,
}) {
  let chunk = currentChunk;
  let tokens = currentTokens;
  const pieceTokens = countTokens(piece);

  if (pieceTokens > maxTokens) {
    if (chunk.trim()) {
      chunks.push(chunk.trim());
      chunk = getTrailingOverlap(chunk, overlapTokens);
      tokens = countTokens(chunk);
    }
    for (const part of hardSplitByTokens(piece, maxTokens)) {
      if (chunk.trim() && countTokens(chunk + part) > maxTokens) {
        chunks.push(chunk.trim());
        chunk = getTrailingOverlap(chunk, overlapTokens);
      }
      chunk = (chunk || "") + part;
      if (countTokens(chunk) > maxTokens) {
        chunks.push(chunk.trim());
        chunk = getTrailingOverlap(chunk, overlapTokens);
      }
    }
    return { currentChunk: chunk, currentTokens: countTokens(chunk) };
  }

  if (tokens + pieceTokens > maxTokens && chunk.trim()) {
    const overlap = getTrailingOverlap(chunk, overlapTokens);
    chunks.push(chunk.trim());
    chunk = (overlap ? overlap : "") + piece;
    tokens = countTokens(chunk);
  } else {
    chunk += piece;
    tokens += pieceTokens;
  }
  return { currentChunk: chunk, currentTokens: tokens };
}

/**
 * Splits text into chunks by token count using cl100k_base tokenizer.
 * Respects paragraph boundaries and applies sliding window token overlap.
 * Oversized single lines (minified JSON, etc.) are hard-split so no chunk
 * exceeds maxTokens — this prevents OpenAI embedding 8192-token failures.
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
        const lineWithNl = line + "\n";
        const next = appendWithinTokenBudget({
          chunks,
          currentChunk,
          currentTokens,
          piece: lineWithNl,
          maxTokens,
          overlapTokens,
        });
        currentChunk = next.currentChunk;
        currentTokens = next.currentTokens;
      }
      continue;
    }

    const next = appendWithinTokenBudget({
      chunks,
      currentChunk,
      currentTokens,
      piece: para + "\n\n",
      maxTokens,
      overlapTokens,
    });
    currentChunk = next.currentChunk;
    currentTokens = next.currentTokens;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Final safety: never return a chunk above maxTokens
  const safe = [];
  for (const c of chunks) {
    if (countTokens(c) <= maxTokens) {
      safe.push(c);
    } else {
      safe.push(...hardSplitByTokens(c, maxTokens));
    }
  }
  return safe;
}

/**
 * Ensure every string is within maxTokens for embedding APIs.
 * Prefer hard-splitting over truncation. Always-on safety net.
 *
 * @param {string[]} texts
 * @param {number} [maxTokens]
 * @param {{ oneToOne?: boolean }} [opts] - when true, keep array length (first piece only)
 * @returns {{ texts: string[], splitCount: number }}
 */
function ensureEmbedTokenLimit(texts, maxTokens, opts = {}) {
  const limit =
    Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Number(maxTokens)
      : Number(process.env.EMBED_MAX_TOKENS) || 8192;
  // Leave headroom for tokenizer variance / model differences
  const safeLimit = Math.max(
    256,
    Number(process.env.EMBED_SAFE_TOKENS) || Math.min(limit - 392, 7800),
  );
  const oneToOne = Boolean(opts.oneToOne);

  const out = [];
  let splitCount = 0;
  for (const raw of texts || []) {
    const text = typeof raw === "string" ? raw : String(raw || "");
    if (!text) {
      out.push("");
      continue;
    }
    if (countTokens(text) <= safeLimit) {
      out.push(text);
      continue;
    }
    splitCount += 1;
    const parts = hardSplitByTokens(text, safeLimit);
    if (oneToOne) {
      out.push(parts[0] || text.slice(0, Math.max(256, safeLimit * 3)));
    } else if (parts.length) {
      out.push(...parts);
    } else {
      out.push(text.slice(0, safeLimit * 3));
    }
  }
  return { texts: out, splitCount };
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
  splitByTokens,
  hardSplitByTokens,
  ensureEmbedTokenLimit,
  createParentChildChunks,
};
