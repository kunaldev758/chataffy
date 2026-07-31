const { v4: uuidv4 } = require("uuid");
const { get_encoding } = require("tiktoken");

// ─── Exact Token Counting ────────────────────────────────────────────────────
// All chunk sizing is measured in cl100k_base tokens — the unit the embedding
// model actually bills and truncates on — rather than characters.
let _encoder = null;
function getTokenEncoder() {
  if (!_encoder) {
    try {
      _encoder = get_encoding("cl100k_base");
    } catch (err) {
      console.warn(`[chunking] Failed to init tiktoken encoder: ${err.message}`);
      _encoder = false; // sentinel: fall back to char estimate
    }
  }
  return _encoder || null;
}

function countTokens(text) {
  if (!text) return 0;
  const enc = getTokenEncoder();
  if (!enc) return Math.ceil(String(text).length / 4);
  try {
    return enc.encode(String(text)).length;
  } catch (_) {
    return Math.ceil(String(text).length / 4);
  }
}

/**
 * Last-resort fallback for a single unbroken run of text (no paragraph/line
 * boundaries at all — e.g. long unbroken CJK/emoji runs, minified code,
 * giant URLs) that still exceeds maxTokens. Slices the raw token id array
 * directly so the result is exactly bounded, regardless of script/whitespace.
 */
function hardSplitByTokens(text, maxTokens) {
  const enc = getTokenEncoder();
  if (!enc) {
    // No tokenizer available — fall back to a conservative char slice.
    const approxChars = maxTokens * 3;
    const pieces = [];
    for (let i = 0; i < text.length; i += approxChars) {
      pieces.push(text.slice(i, i + approxChars));
    }
    return pieces;
  }
  const ids = enc.encode(text);
  const pieces = [];
  for (let i = 0; i < ids.length; i += maxTokens) {
    const slice = ids.slice(i, i + maxTokens);
    pieces.push(Buffer.from(enc.decode(slice)).toString("utf8"));
  }
  return pieces;
}

/**
 * Splits text into pieces that each fit within `maxTokens`, preferring to
 * break on paragraph then line boundaries, falling back to a hard token-id
 * slice for unbroken runs. No overlap is added here — this enforces the hard
 * ceiling on text that bypassed the main splitter (an intact protected block
 * or an under-target section).
 */
function splitByTokenBudget(text, maxTokens) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  if (countTokens(raw) <= maxTokens) return [raw];

  const paragraphs = raw.split(/\n\s*\n/);
  const pieces = [];
  let current = "";

  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if (countTokens(para) > maxTokens) {
      flush();
      const lines = para.split(/\n/);
      let lineBuf = "";
      for (const line of lines) {
        const candidate = lineBuf ? `${lineBuf}\n${line}` : line;
        if (countTokens(candidate) > maxTokens && lineBuf) {
          pieces.push(lineBuf.trim());
          lineBuf = line;
        } else if (countTokens(candidate) > maxTokens && !lineBuf) {
          // Single line alone exceeds the budget — no whitespace to break on.
          pieces.push(...hardSplitByTokens(line, maxTokens));
          lineBuf = "";
        } else {
          lineBuf = candidate;
        }
      }
      if (lineBuf.trim()) pieces.push(lineBuf.trim());
      continue;
    }

    const candidate = current ? `${current}\n\n${para}` : para;
    if (countTokens(candidate) > maxTokens && current) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  return pieces.filter(Boolean);
}

// ─── Token budgets ───────────────────────────────────────────────────────────
// Targets are what the splitter aims for; the *_MAX_* ceilings are hard limits
// enforced afterwards, since a protected block (FAQ pair, product details) is
// allowed to run slightly past its target to stay intact.

/** Default target for a standalone chunk when no parent/child sizing is given. */
const DEFAULT_CHUNK_TOKENS = parseInt(process.env.RAG_CHUNK_TOKENS || "500", 10);
const DEFAULT_OVERLAP_TOKENS = parseInt(
  process.env.RAG_CHUNK_OVERLAP_TOKENS || "100",
  10,
);

/** Parent window stored on each child payload as LLM context. */
const DEFAULT_PARENT_TOKENS = parseInt(
  process.env.RAG_PARENT_TOKENS || "850",
  10,
);
/** Child window embedded in Qdrant — small, for high vector precision. */
const DEFAULT_CHILD_TOKENS = parseInt(process.env.RAG_CHILD_TOKENS || "180", 10);
const DEFAULT_PARENT_OVERLAP_TOKENS = parseInt(
  process.env.RAG_PARENT_OVERLAP_TOKENS || "50",
  10,
);
const DEFAULT_CHILD_OVERLAP_TOKENS = parseInt(
  process.env.RAG_CHILD_OVERLAP_TOKENS || "30",
  10,
);

/** Hard ceilings — no chunk may exceed these regardless of target. */
const DEFAULT_MAX_TOKENS_PER_CHUNK = parseInt(
  process.env.RAG_CHUNK_MAX_TOKENS || "700",
  10,
);
const DEFAULT_PARENT_MAX_TOKENS = parseInt(
  process.env.RAG_PARENT_MAX_TOKENS || "1000",
  10,
);
const DEFAULT_CHILD_MAX_TOKENS = parseInt(
  process.env.RAG_CHILD_MAX_TOKENS || "220",
  10,
);

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Temporarily replace fenced code blocks so they are not split mid-fence.
 * @returns {{ text: string, restore: (s: string) => string }}
 */
function protectCodeBlocks(markdown) {
  const blocks = [];
  const text = String(markdown || "").replace(/```[\s\S]*?```/g, (match) => {
    const idx = blocks.length;
    blocks.push(match);
    return `\n\n@@CODE_BLOCK_${idx}@@\n\n`;
  });
  return {
    text,
    restore: (s) =>
      String(s || "").replace(/@@CODE_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
  };
}

/**
 * Protect simple Q/A pairs (FAQ) so question+answer stay in one unit when possible.
 * Patterns: bold Q/A markers, plain Q:/A: lines, Question/Answer labels.
 */
function protectQaPairs(markdown) {
  const blocks = [];
  let text = String(markdown || "");

  // Bold Q/A blocks
  text = text.replace(
    /(\*\*Q[:?]?\*\*[^\n]*(?:\n(?!\*\*Q[:?]?\*\*)[^\n]*)*)(\n\*\*A[:?]?\*\*[^\n]*(?:\n(?!\*\*[QA][:?]?\*\*)[^\n]*)*)/gi,
    (match) => {
      const idx = blocks.length;
      blocks.push(match);
      return `\n\n@@QA_BLOCK_${idx}@@\n\n`;
    },
  );

  // Plain Q:/A: lines
  text = text.replace(
    /(^|\n)(Q[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)(\nA[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)/gi,
    (match, lead, q, a) => {
      const idx = blocks.length;
      blocks.push(`${q}${a}`);
      return `${lead}@@QA_BLOCK_${idx}@@`;
    },
  );

  // Question: / Answer: labels (common FAQ markdown)
  text = text.replace(
    /(^|\n)((?:Question|Q)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)(\n(?:Answer|A)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)/gi,
    (match, lead, q, a) => {
      const idx = blocks.length;
      blocks.push(`${q}${a}`);
      return `${lead}@@QA_BLOCK_${idx}@@`;
    },
  );

  return {
    text,
    restore: (s) =>
      String(s || "").replace(/@@QA_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
  };
}

/**
 * Keep product "Details" attribute blocks together when possible.
 */
function protectProductBlocks(markdown) {
  const blocks = [];
  let text = String(markdown || "");

  text = text.replace(
    /(^|\n)(#{1,3}\s*Details\b[^\n]*\n(?:[-*]\s+[^\n]+\n?)+)/gi,
    (match, lead, block) => {
      const idx = blocks.length;
      blocks.push(block.trim());
      return `${lead}@@PRODUCT_BLOCK_${idx}@@\n`;
    },
  );

  return {
    text,
    restore: (s) =>
      String(s || "").replace(
        /@@PRODUCT_BLOCK_(\d+)@@/g,
        (_, n) => blocks[Number(n)] || "",
      ),
  };
}

function cleanHeadingTitle(raw) {
  return String(raw || "")
    .replace(/[#*_`]/g, "")
    .trim();
}

/**
 * Split markdown into heading sections with breadcrumb paths.
 * @returns {{ heading_path: string, text: string, level: number }[]}
 */
function splitByHeadings(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const sections = [];
  const stack = []; // { level, title }
  let buf = [];
  let currentPath = "";
  let currentLevel = 0;

  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    sections.push({
      heading_path: currentPath,
      text: body,
      level: currentLevel,
    });
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      const level = m[1].length;
      const title = cleanHeadingTitle(m[2]);
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      currentPath = stack.map((s) => s.title).filter(Boolean).join(" > ");
      currentLevel = level;
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();

  if (sections.length === 0 && String(markdown || "").trim()) {
    return [
      {
        heading_path: "",
        text: String(markdown).trim(),
        level: 0,
      },
    ];
  }
  return sections;
}

/** Coarse → fine break points, tried in order. */
const DEFAULT_SEPARATORS = ["\n## ", "\n### ", "\n\n", "\n", ". ", " "];

/**
 * Marginal token cost of re-joining two pieces with `separator`.
 *
 * Counting a separator on its own over-states it, since BPE folds it into the
 * token that follows (" " + "word" is one token, not two). Measuring the
 * difference once keeps the running total in the packing loop close enough to
 * the truth that chunks fill their budget without re-encoding on every piece.
 */
/**
 * Memoized count for the short, highly repetitive pieces the splitter produces
 * at the finest separators (single words, list bullets). Bounded so a large
 * crawl can't grow it without limit; long pieces skip the cache entirely since
 * they rarely repeat.
 */
const PIECE_CACHE_MAX_CHARS = 64;
const PIECE_CACHE_MAX_ENTRIES = 5000;
const _pieceTokenCache = new Map();
function countPieceTokens(piece) {
  if (piece.length > PIECE_CACHE_MAX_CHARS) return countTokens(piece);
  const cached = _pieceTokenCache.get(piece);
  if (cached !== undefined) return cached;
  const tokens = countTokens(piece);
  if (_pieceTokenCache.size >= PIECE_CACHE_MAX_ENTRIES) _pieceTokenCache.clear();
  _pieceTokenCache.set(piece, tokens);
  return tokens;
}

const _separatorCostCache = new Map();
function separatorTokenCost(separator) {
  if (!separator) return 0;
  if (_separatorCostCache.has(separator)) {
    return _separatorCostCache.get(separator);
  }
  const cost = Math.max(
    0,
    countTokens(`word${separator}word`) - 2 * countTokens("word"),
  );
  _separatorCostCache.set(separator, cost);
  return cost;
}

/**
 * Recursive token-budget splitter.
 *
 * Walks the separator ladder from coarsest to finest, packing consecutive
 * pieces into a chunk until the next one would exceed `maxTokens`, then
 * carrying a tail of up to `overlapTokens` into the following chunk. A piece
 * that is itself over budget recurses onto the next-finer separator, and text
 * with no break point left (unbroken CJK runs, giant URLs, minified code) is
 * sliced directly on token ids.
 *
 * Every measurement is an exact cl100k_base count, so a chunk can never
 * silently overrun the embedding budget the way a character estimate can.
 *
 * @returns {string[]}
 */
function splitTextByTokens(text, options = {}) {
  const {
    maxTokens,
    overlapTokens = 0,
    separators = DEFAULT_SEPARATORS,
  } = options;

  const raw = String(text || "");
  if (!raw.trim()) return [];
  if (countTokens(raw) <= maxTokens) return [raw.trim()];

  const separatorIndex = separators.findIndex((s) => raw.includes(s));
  if (separatorIndex === -1) return hardSplitByTokens(raw, maxTokens);

  const separator = separators[separatorIndex];
  const finerSeparators = separators.slice(separatorIndex + 1);
  const separatorTokens = separatorTokenCost(separator);

  const chunks = [];
  let buffer = [];
  let bufferCounts = [];
  let bufferTokens = 0;

  const flush = () => {
    const joined = buffer.join(separator).trim();
    if (joined) chunks.push(joined);
  };

  for (const piece of raw.split(separator)) {
    const pieceTokens = countPieceTokens(piece);

    // Still too big on its own — hand it to the next-finer separator.
    if (pieceTokens > maxTokens) {
      if (buffer.length) {
        flush();
        buffer = [];
        bufferCounts = [];
        bufferTokens = 0;
      }
      chunks.push(
        ...splitTextByTokens(piece, {
          maxTokens,
          overlapTokens,
          separators: finerSeparators,
        }),
      );
      continue;
    }

    if (buffer.length && bufferTokens + separatorTokens + pieceTokens > maxTokens) {
      // The running sum is an upper bound: counting each piece and separator
      // separately over-counts, because BPE merges a separator into the token
      // that follows it. Confirm against the joined text before flushing so we
      // don't cut chunks short (worst case, one-token pieces would otherwise
      // fill only half the budget).
      const exactTokens = countTokens([...buffer, piece].join(separator));
      if (exactTokens <= maxTokens) {
        buffer.push(piece);
        bufferCounts.push(pieceTokens);
        bufferTokens = exactTokens;
        continue;
      }

      flush();
      // Drop from the front until the retained tail fits the overlap budget
      // and leaves room for the incoming piece.
      while (
        buffer.length &&
        (bufferTokens > overlapTokens ||
          bufferTokens + separatorTokens + pieceTokens > maxTokens)
      ) {
        buffer.shift();
        const droppedTokens = bufferCounts.shift() || 0;
        bufferTokens -= droppedTokens + (buffer.length ? separatorTokens : 0);
        if (bufferTokens < 0) bufferTokens = 0;
      }
    }

    bufferTokens += (buffer.length ? separatorTokens : 0) + pieceTokens;
    buffer.push(piece);
    bufferCounts.push(pieceTokens);
  }

  flush();
  return chunks.filter(Boolean);
}

/**
 * Structure-aware chunking, optionally tuned by section entity_type:
 * - faq: stronger Q/A protection
 * - product: keep Details attribute blocks together
 * - policy/review/general: heading + paragraph splits
 *
 * @returns {Promise<{ text: string, heading_path: string }[]>}
 */
async function structureAwareChunk(markdown, options = {}) {
  const targetTokens = options.targetTokens ?? DEFAULT_CHUNK_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_PER_CHUNK;
  const entityType = String(options.entity_type || options.pageType || "general")
    .toLowerCase()
    .trim();

  const code = protectCodeBlocks(markdown);
  let working = code.text;
  const restorers = [];

  if (entityType === "faq") {
    const qa = protectQaPairs(working);
    working = qa.text;
    restorers.push(qa.restore);
  } else if (entityType === "product" || entityType === "listing") {
    const product = protectProductBlocks(working);
    working = product.text;
    restorers.push(product.restore);
    // Light Q/A protect in case PDP embeds mini-FAQ not split out
    const qa = protectQaPairs(working);
    working = qa.text;
    restorers.push(qa.restore);
  } else {
    const qa = protectQaPairs(working);
    working = qa.text;
    restorers.push(qa.restore);
  }

  const restoreAll = (s) => {
    let out = s;
    for (let i = restorers.length - 1; i >= 0; i--) {
      out = restorers[i](out);
    }
    return code.restore(out);
  };

  const sections = splitByHeadings(working);
  const out = [];

  // Ceiling enforcement: the splitter already targets targetTokens, so this
  // only fires for a section that passed through whole (protected block or
  // under-target section) yet still exceeds the hard maxTokens limit.
  const pushBounded = (text, heading_path) => {
    const pieces =
      countTokens(text) <= maxTokens ? [text] : splitByTokenBudget(text, maxTokens);
    for (const piece of pieces) {
      if (piece) out.push({ text: piece, heading_path });
    }
  };

  for (const section of sections) {
    const restored = restoreAll(section.text).trim();
    if (!restored) continue;
    const sectionTokens = countTokens(restored);

    // FAQ: prefer not splitting a single protected Q/A unit further when small
    if (entityType === "faq" && sectionTokens <= targetTokens * 1.25) {
      pushBounded(restored, section.heading_path || "");
      continue;
    }

    if (sectionTokens <= targetTokens) {
      pushBounded(restored, section.heading_path || "");
      continue;
    }

    const parts = splitTextByTokens(restored, {
      maxTokens: targetTokens,
      overlapTokens,
    });
    for (const part of parts) {
      const text = part.trim();
      if (!text) continue;
      pushBounded(text, section.heading_path || "");
    }
  }

  if (out.length === 0 && String(markdown || "").trim()) {
    const parts = splitTextByTokens(String(markdown).trim(), {
      maxTokens: targetTokens,
      overlapTokens,
    });
    const fallbackOut = [];
    for (const t of parts) {
      const text = t.trim();
      if (!text) continue;
      const pieces =
        countTokens(text) <= maxTokens ? [text] : splitByTokenBudget(text, maxTokens);
      for (const piece of pieces) {
        if (piece) fallbackOut.push({ text: piece, heading_path: "" });
      }
    }
    return fallbackOut;
  }

  return out;
}

/**
 * Parent-child chunking: embed small children (~180 tokens), store the parent
 * (~850 tokens) on each child payload for high-precision search + broader LLM
 * context.
 *
 * @returns {Promise<Array<{
 *   text: string,
 *   parent_text: string,
 *   parent_id: string,
 *   parent_index: number,
 *   child_index: number,
 *   heading_path: string,
 *   chunk_role: 'child',
 * }>>}
 */
async function structureAwareParentChildChunk(markdown, options = {}) {
  const parentTokens = options.parentTokens ?? DEFAULT_PARENT_TOKENS;
  const parentOverlapTokens =
    options.parentOverlapTokens ?? DEFAULT_PARENT_OVERLAP_TOKENS;
  const childTokens = options.childTokens ?? DEFAULT_CHILD_TOKENS;
  const childOverlapTokens =
    options.childOverlapTokens ?? DEFAULT_CHILD_OVERLAP_TOKENS;
  const parentMaxTokens = options.parentMaxTokens ?? DEFAULT_PARENT_MAX_TOKENS;
  const childMaxTokens = options.childMaxTokens ?? DEFAULT_CHILD_MAX_TOKENS;

  // First pass: structure-aware sections at parent granularity
  const parentParts = await structureAwareChunk(markdown, {
    targetTokens: parentTokens,
    overlapTokens: parentOverlapTokens,
    entity_type: options.entity_type,
    pageType: options.pageType,
    maxTokens: parentMaxTokens,
  });

  const children = [];
  let globalChildIndex = 0;

  // Child-level token safety net — children are embedded directly, so
  // keeping them near their intended ~150-200 token precision target
  // matters more here than at the parent level. No-op for ordinary text.
  const pushChild = ({ text, parentText, parentId, parentIndex, headingPath, localIndexRef }) => {
    const pieces =
      countTokens(text) <= childMaxTokens ? [text] : splitByTokenBudget(text, childMaxTokens);
    for (const piece of pieces) {
      if (!piece) continue;
      children.push({
        text: piece,
        parent_text: parentText,
        parent_id: parentId,
        parent_index: parentIndex,
        child_index: globalChildIndex++,
        heading_path: headingPath,
        chunk_role: "child",
        ...(localIndexRef ? { parent_child_index: localIndexRef.i++ } : {}),
      });
    }
  };

  for (let parentIndex = 0; parentIndex < parentParts.length; parentIndex++) {
    const parentPart = parentParts[parentIndex];
    const parentText = parentPart.text.trim();
    if (!parentText) continue;

    const parentId = uuidv4();
    const headingPath = parentPart.heading_path || "";

    // Small parent sections become a single child (avoid over-fragmentation)
    if (countTokens(parentText) <= childTokens * 1.15) {
      pushChild({ text: parentText, parentText, parentId, parentIndex, headingPath });
      continue;
    }

    const childParts = splitTextByTokens(parentText, {
      maxTokens: childTokens,
      overlapTokens: childOverlapTokens,
    });

    const localIndexRef = { i: 0 };
    for (const part of childParts) {
      const childText = part.trim();
      if (!childText) continue;
      pushChild({
        text: childText,
        parentText,
        parentId,
        parentIndex,
        headingPath,
        localIndexRef,
      });
    }
  }

  return children;
}

module.exports = {
  structureAwareChunk,
  structureAwareParentChildChunk,
  splitByHeadings,
  protectCodeBlocks,
  protectQaPairs,
  protectProductBlocks,
  countTokens,
  splitByTokenBudget,
  splitTextByTokens,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  DEFAULT_PARENT_TOKENS,
  DEFAULT_CHILD_TOKENS,
  DEFAULT_PARENT_OVERLAP_TOKENS,
  DEFAULT_CHILD_OVERLAP_TOKENS,
  DEFAULT_MAX_TOKENS_PER_CHUNK,
  DEFAULT_PARENT_MAX_TOKENS,
  DEFAULT_CHILD_MAX_TOKENS,
};
