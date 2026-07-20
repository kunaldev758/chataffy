const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

const DEFAULT_CHUNK_CHARS = 2000; // ~500 tokens
const DEFAULT_OVERLAP_CHARS = 400;

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
 * Patterns: bold Q/A markers, plain Q:/A: lines.
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

  return {
    text,
    restore: (s) =>
      String(s || "").replace(/@@QA_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
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
 * Structure-aware chunking:
 * protect code/Q-A → heading sections → recursive split oversized sections.
 *
 * @returns {Promise<{ text: string, heading_path: string }[]>}
 */
async function structureAwareChunk(markdown, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_CHARS;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_OVERLAP_CHARS;

  const code = protectCodeBlocks(markdown);
  const qa = protectQaPairs(code.text);
  const sections = splitByHeadings(qa.text);

  const out = [];

  for (const section of sections) {
    const restored = code.restore(qa.restore(section.text)).trim();
    if (!restored) continue;

    if (restored.length <= chunkSize) {
      out.push({
        text: restored,
        heading_path: section.heading_path || "",
      });
      continue;
    }

    // Oversized: recursive split, keep same heading_path
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

  // Safety: if somehow empty, fall back to pure recursive on original
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

module.exports = {
  structureAwareChunk,
  splitByHeadings,
  protectCodeBlocks,
  protectQaPairs,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
};
