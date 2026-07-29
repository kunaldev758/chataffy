const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { v4: uuidv4 } = require("uuid");

const DEFAULT_CHUNK_CHARS = 2000; // ~500 tokens
const DEFAULT_OVERLAP_CHARS = 400;

/** Parent window for parent-child retrieval (~2000 chars). */
const DEFAULT_PARENT_CHARS = parseInt(
  process.env.RAG_PARENT_CHARS || "2000",
  10,
);
/** Child window embedded in Qdrant (~400 chars). */
const DEFAULT_CHILD_CHARS = parseInt(process.env.RAG_CHILD_CHARS || "400", 10);
const DEFAULT_PARENT_OVERLAP_CHARS = parseInt(
  process.env.RAG_PARENT_OVERLAP_CHARS || "200",
  10,
);
const DEFAULT_CHILD_OVERLAP_CHARS = parseInt(
  process.env.RAG_CHILD_OVERLAP_CHARS || "60",
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

async function recursiveSplit(text, { chunkSize, chunkOverlap }) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
  });
  const docs = await splitter.createDocuments([text]);
  return docs.map((d) => d.pageContent);
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
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_CHARS;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_OVERLAP_CHARS;
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

  for (const section of sections) {
    const restored = restoreAll(section.text).trim();
    if (!restored) continue;

    // FAQ: prefer not splitting a single protected Q/A unit further when small
    if (entityType === "faq" && restored.length <= chunkSize * 1.25) {
      out.push({
        text: restored,
        heading_path: section.heading_path || "",
      });
      continue;
    }

    if (restored.length <= chunkSize) {
      out.push({
        text: restored,
        heading_path: section.heading_path || "",
      });
      continue;
    }

    const parts = await recursiveSplit(restored, { chunkSize, chunkOverlap });
    for (const part of parts) {
      const text = part.trim();
      if (!text) continue;
      out.push({
        text,
        heading_path: section.heading_path || "",
      });
    }
  }

  if (out.length === 0 && String(markdown || "").trim()) {
    const parts = await recursiveSplit(String(markdown).trim(), {
      chunkSize,
      chunkOverlap,
    });
    return parts
      .map((t) => ({ text: t.trim(), heading_path: "" }))
      .filter((c) => c.text);
  }

  return out;
}

/**
 * Parent-child chunking: embed small children (~400 chars), store parent (~2000 chars)
 * on each child payload for high-precision search + broader LLM context.
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
  const parentSize = options.parentSize ?? DEFAULT_PARENT_CHARS;
  const parentOverlap = options.parentOverlap ?? DEFAULT_PARENT_OVERLAP_CHARS;
  const childSize = options.childSize ?? DEFAULT_CHILD_CHARS;
  const childOverlap = options.childOverlap ?? DEFAULT_CHILD_OVERLAP_CHARS;

  // First pass: structure-aware sections at parent granularity
  const parentParts = await structureAwareChunk(markdown, {
    chunkSize: parentSize,
    chunkOverlap: parentOverlap,
    entity_type: options.entity_type,
    pageType: options.pageType,
  });

  const children = [];
  let globalChildIndex = 0;

  for (let parentIndex = 0; parentIndex < parentParts.length; parentIndex++) {
    const parentPart = parentParts[parentIndex];
    const parentText = parentPart.text.trim();
    if (!parentText) continue;

    const parentId = uuidv4();
    const headingPath = parentPart.heading_path || "";

    // Small parent sections become a single child (avoid over-fragmentation)
    if (parentText.length <= childSize * 1.15) {
      children.push({
        text: parentText,
        parent_text: parentText,
        parent_id: parentId,
        parent_index: parentIndex,
        child_index: globalChildIndex++,
        heading_path: headingPath,
        chunk_role: "child",
      });
      continue;
    }

    const childParts = await recursiveSplit(parentText, {
      chunkSize: childSize,
      chunkOverlap: childOverlap,
    });

    let localChildIndex = 0;
    for (const part of childParts) {
      const childText = part.trim();
      if (!childText) continue;
      children.push({
        text: childText,
        parent_text: parentText,
        parent_id: parentId,
        parent_index: parentIndex,
        child_index: globalChildIndex++,
        heading_path: headingPath,
        chunk_role: "child",
        parent_child_index: localChildIndex++,
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
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_PARENT_CHARS,
  DEFAULT_CHILD_CHARS,
  DEFAULT_PARENT_OVERLAP_CHARS,
  DEFAULT_CHILD_OVERLAP_CHARS,
};
