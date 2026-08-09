/**
 * Heading-path tracking for RAG chunks.
 * Scans markdown / plain section titles without changing token split sizes.
 */

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** Common non-markdown section labels (e.g. product pages after HTML→text). */
const PLAIN_SECTION =
  /^(?:features?|specifications?|specs?|description|details?|overview|benefits?|shipping|returns?|warranty|safety|installation|ingredients?|reviews?|faq|frequently asked questions|what'?s included|compatibility|dimensions?|materials?)\s*:?\s*$/i;

function cleanHeadingTitle(raw) {
  return String(raw || "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @returns {{ level: number, title: string } | null}
 */
function matchHeadingLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.length > 120) return null;

  const atx = trimmed.match(ATX_HEADING);
  if (atx) {
    return { level: atx[1].length, title: cleanHeadingTitle(atx[2]) };
  }

  // Setext-style not handled; bold-only short lines e.g. **Safety**
  const bold = trimmed.match(/^\*\*(.+?)\*\*$/) || trimmed.match(/^__(.+?)__$/);
  if (bold) {
    const title = cleanHeadingTitle(bold[1]);
    if (title && title.length >= 2 && title.length <= 80) {
      return { level: 2, title };
    }
  }

  if (PLAIN_SECTION.test(trimmed)) {
    return { level: 2, title: cleanHeadingTitle(trimmed.replace(/:$/, "")) };
  }

  return null;
}

function pathFromStack(stack) {
  return stack
    .map((h) => h.title)
    .filter(Boolean)
    .join(" > ");
}

/**
 * Split document into spans under an active heading path.
 * @returns {{ heading_path: string, text: string, start: number, end: number }[]}
 */
function buildHeadingSpans(text) {
  const source = String(text || "");
  if (!source.trim()) return [];

  const lines = source.split("\n");
  const stack = [];
  const spans = [];
  let buf = [];
  let spanStart = 0;
  let offset = 0;

  const flush = (endOffset) => {
    const content = buf.join("\n");
    if (content.trim()) {
      spans.push({
        heading_path: pathFromStack(stack),
        text: content,
        start: spanStart,
        end: endOffset,
      });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = matchHeadingLine(line);
    const lineStart = offset;

    if (heading && heading.title) {
      flush(lineStart);
      while (stack.length && stack[stack.length - 1].level >= heading.level) {
        stack.pop();
      }
      stack.push(heading);
      // Heading line itself starts the next span
      spanStart = lineStart;
      buf.push(line);
    } else {
      if (buf.length === 0) spanStart = lineStart;
      buf.push(line);
    }

    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  flush(source.length);

  return spans;
}

/**
 * Pick best heading_path for a chunk via span overlap / prefix match.
 * Prefers deeper paths and mid-chunk matches (not only the document H1).
 */
function resolveHeadingPathForChunk(chunkText, spans = []) {
  const chunk = String(chunkText || "").trim();
  if (!chunk || !spans.length) return "";

  const windows = [
    chunk.slice(0, Math.min(120, chunk.length)),
    chunk.slice(
      Math.max(0, Math.floor(chunk.length / 2) - 40),
      Math.floor(chunk.length / 2) + 40,
    ),
    chunk.slice(Math.max(0, chunk.length - 120)),
  ].filter((w) => w && w.trim().length >= 20);

  let bestPath = "";
  let bestScore = 0;

  for (const span of spans) {
    const hay = span.text || "";
    if (!hay.trim()) continue;

    let score = 0;
    for (const w of windows) {
      if (hay.includes(w)) score += w.length;
      else if (w.includes(hay.slice(0, Math.min(60, hay.length)))) score += 20;
    }

    // Shared non-empty lines
    const chunkLines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 12)
      .slice(0, 8);
    for (const line of chunkLines) {
      if (hay.includes(line)) score += Math.min(line.length, 40);
    }

    const depth = (span.heading_path.match(/>/g) || []).length;
    score += depth * 15;

    // Prefer non-empty section paths over bare title when scores tie-ish
    if (span.heading_path && score > 0) score += 5;

    if (score > bestScore) {
      bestScore = score;
      bestPath = span.heading_path || "";
    }
  }

  // If chunk opens with its own heading, ensure that title appears in the path
  const firstLine = chunk.split("\n").find((l) => l.trim()) || "";
  const local = matchHeadingLine(firstLine);
  if (local?.title) {
    if (!bestPath) return local.title;
    if (!bestPath.split(" > ").includes(local.title)) {
      return `${bestPath} > ${local.title}`;
    }
  }

  return bestPath;
}

/**
 * Format heading path for contextualText / display.
 */
function formatHeadingPath(path) {
  return String(path || "")
    .replace(/\s*>\s*/g, " > ")
    .trim();
}

module.exports = {
  matchHeadingLine,
  buildHeadingSpans,
  resolveHeadingPathForChunk,
  formatHeadingPath,
};
