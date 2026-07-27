// // const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

// // const DEFAULT_CHUNK_CHARS = 2000; // ~500 tokens
// // const DEFAULT_OVERLAP_CHARS = 400;

// // const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// // /**
// //  * Temporarily replace fenced code blocks so they are not split mid-fence.
// //  * @returns {{ text: string, restore: (s: string) => string }}
// //  */
// // function protectCodeBlocks(markdown) {
// //   const blocks = [];
// //   const text = String(markdown || "").replace(/```[\s\S]*?```/g, (match) => {
// //     const idx = blocks.length;
// //     blocks.push(match);
// //     return `\n\n@@CODE_BLOCK_${idx}@@\n\n`;
// //   });
// //   return {
// //     text,
// //     restore: (s) =>
// //       String(s || "").replace(/@@CODE_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
// //   };
// // }

// // /**
// //  * Protect simple Q/A pairs (FAQ) so question+answer stay in one unit when possible.
// //  * Patterns: bold Q/A markers, plain Q:/A: lines, Question/Answer labels.
// //  */
// // function protectQaPairs(markdown) {
// //   const blocks = [];
// //   let text = String(markdown || "");

// //   // Bold Q/A blocks
// //   text = text.replace(
// //     /(\*\*Q[:?]?\*\*[^\n]*(?:\n(?!\*\*Q[:?]?\*\*)[^\n]*)*)(\n\*\*A[:?]?\*\*[^\n]*(?:\n(?!\*\*[QA][:?]?\*\*)[^\n]*)*)/gi,
// //     (match) => {
// //       const idx = blocks.length;
// //       blocks.push(match);
// //       return `\n\n@@QA_BLOCK_${idx}@@\n\n`;
// //     },
// //   );

// //   // Plain Q:/A: lines
// //   text = text.replace(
// //     /(^|\n)(Q[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)(\nA[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)/gi,
// //     (match, lead, q, a) => {
// //       const idx = blocks.length;
// //       blocks.push(`${q}${a}`);
// //       return `${lead}@@QA_BLOCK_${idx}@@`;
// //     },
// //   );

// //   // Question: / Answer: labels (common FAQ markdown)
// //   text = text.replace(
// //     /(^|\n)((?:Question|Q)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)(\n(?:Answer|A)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)/gi,
// //     (match, lead, q, a) => {
// //       const idx = blocks.length;
// //       blocks.push(`${q}${a}`);
// //       return `${lead}@@QA_BLOCK_${idx}@@`;
// //     },
// //   );

// //   return {
// //     text,
// //     restore: (s) =>
// //       String(s || "").replace(/@@QA_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
// //   };
// // }

// // /**
// //  * Keep product "Details" attribute blocks together when possible.
// //  */
// // function protectProductBlocks(markdown) {
// //   const blocks = [];
// //   let text = String(markdown || "");

// //   text = text.replace(
// //     /(^|\n)(#{1,3}\s*Details\b[^\n]*\n(?:[-*]\s+[^\n]+\n?)+)/gi,
// //     (match, lead, block) => {
// //       const idx = blocks.length;
// //       blocks.push(block.trim());
// //       return `${lead}@@PRODUCT_BLOCK_${idx}@@\n`;
// //     },
// //   );

// //   return {
// //     text,
// //     restore: (s) =>
// //       String(s || "").replace(
// //         /@@PRODUCT_BLOCK_(\d+)@@/g,
// //         (_, n) => blocks[Number(n)] || "",
// //       ),
// //   };
// // }

// // function cleanHeadingTitle(raw) {
// //   return String(raw || "")
// //     .replace(/[#*_`]/g, "")
// //     .trim();
// // }

// // /**
// //  * Split markdown into heading sections with breadcrumb paths.
// //  * @returns {{ heading_path: string, text: string, level: number }[]}
// //  */
// // function splitByHeadings(markdown) {
// //   const lines = String(markdown || "").split(/\r?\n/);
// //   const sections = [];
// //   const stack = []; // { level, title }
// //   let buf = [];
// //   let currentPath = "";
// //   let currentLevel = 0;

// //   const flush = () => {
// //     const body = buf.join("\n").trim();
// //     buf = [];
// //     if (!body) return;
// //     sections.push({
// //       heading_path: currentPath,
// //       text: body,
// //       level: currentLevel,
// //     });
// //   };

// //   for (const line of lines) {
// //     const m = line.match(HEADING_RE);
// //     if (m) {
// //       flush();
// //       const level = m[1].length;
// //       const title = cleanHeadingTitle(m[2]);
// //       while (stack.length && stack[stack.length - 1].level >= level) {
// //         stack.pop();
// //       }
// //       stack.push({ level, title });
// //       currentPath = stack.map((s) => s.title).filter(Boolean).join(" > ");
// //       currentLevel = level;
// //       buf.push(line);
// //     } else {
// //       buf.push(line);
// //     }
// //   }
// //   flush();

// //   if (sections.length === 0 && String(markdown || "").trim()) {
// //     return [
// //       {
// //         heading_path: "",
// //         text: String(markdown).trim(),
// //         level: 0,
// //       },
// //     ];
// //   }
// //   return sections;
// // }

// // async function recursiveSplit(text, { chunkSize, chunkOverlap }) {
// //   const splitter = new RecursiveCharacterTextSplitter({
// //     chunkSize,
// //     chunkOverlap,
// //     separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
// //   });
// //   const docs = await splitter.createDocuments([text]);
// //   return docs.map((d) => d.pageContent);
// // }

// // /**
// //  * Structure-aware chunking, optionally tuned by section entity_type:
// //  * - faq: stronger Q/A protection
// //  * - product: keep Details attribute blocks together
// //  * - policy/review/general: heading + paragraph splits
// //  *
// //  * @returns {Promise<{ text: string, heading_path: string }[]>}
// //  */
// // async function structureAwareChunk(markdown, options = {}) {
// //   const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_CHARS;
// //   const chunkOverlap = options.chunkOverlap ?? DEFAULT_OVERLAP_CHARS;
// //   const entityType = String(options.entity_type || options.pageType || "general")
// //     .toLowerCase()
// //     .trim();

// //   const code = protectCodeBlocks(markdown);
// //   let working = code.text;
// //   const restorers = [];

// //   if (entityType === "faq") {
// //     const qa = protectQaPairs(working);
// //     working = qa.text;
// //     restorers.push(qa.restore);
// //   } else if (entityType === "product" || entityType === "listing") {
// //     const product = protectProductBlocks(working);
// //     working = product.text;
// //     restorers.push(product.restore);
// //     // Light Q/A protect in case PDP embeds mini-FAQ not split out
// //     const qa = protectQaPairs(working);
// //     working = qa.text;
// //     restorers.push(qa.restore);
// //   } else {
// //     const qa = protectQaPairs(working);
// //     working = qa.text;
// //     restorers.push(qa.restore);
// //   }

// //   const restoreAll = (s) => {
// //     let out = s;
// //     for (let i = restorers.length - 1; i >= 0; i--) {
// //       out = restorers[i](out);
// //     }
// //     return code.restore(out);
// //   };

// //   const sections = splitByHeadings(working);
// //   const out = [];

// //   for (const section of sections) {
// //     const restored = restoreAll(section.text).trim();
// //     if (!restored) continue;

// //     // FAQ: prefer not splitting a single protected Q/A unit further when small
// //     if (entityType === "faq" && restored.length <= chunkSize * 1.25) {
// //       out.push({
// //         text: restored,
// //         heading_path: section.heading_path || "",
// //       });
// //       continue;
// //     }

// //     if (restored.length <= chunkSize) {
// //       out.push({
// //         text: restored,
// //         heading_path: section.heading_path || "",
// //       });
// //       continue;
// //     }

// //     const parts = await recursiveSplit(restored, { chunkSize, chunkOverlap });
// //     for (const part of parts) {
// //       const text = part.trim();
// //       if (!text) continue;
// //       out.push({
// //         text,
// //         heading_path: section.heading_path || "",
// //       });
// //     }
// //   }

// //   if (out.length === 0 && String(markdown || "").trim()) {
// //     const parts = await recursiveSplit(String(markdown).trim(), {
// //       chunkSize,
// //       chunkOverlap,
// //     });
// //     return parts
// //       .map((t) => ({ text: t.trim(), heading_path: "" }))
// //       .filter((c) => c.text);
// //   }

// //   return out;
// // }

// // module.exports = {
// //   structureAwareChunk,
// //   splitByHeadings,
// //   protectCodeBlocks,
// //   protectQaPairs,
// //   protectProductBlocks,
// //   DEFAULT_CHUNK_CHARS,
// //   DEFAULT_OVERLAP_CHARS,
// // };


// const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

// const DEFAULT_CHUNK_CHARS = 2000; // ~500 tokens
// const DEFAULT_OVERLAP_CHARS = 400;

// const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// /**
//  * Temporarily replace fenced code blocks so they are not split mid-fence.
//  * @returns {{ text: string, restore: (s: string) => string }}
//  */
// function protectCodeBlocks(markdown) {
//   const blocks = [];
//   const text = String(markdown || "").replace(/```[\s\S]*?```/g, (match) => {
//     const idx = blocks.length;
//     blocks.push(match);
//     return `\n\n@@CODE_BLOCK_${idx}@@\n\n`;
//   });
//   return {
//     text,
//     restore: (s) =>
//       String(s || "").replace(/@@CODE_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
//   };
// }

// /**
//  * Protect simple Q/A pairs (FAQ) so question+answer stay in one unit when possible.
//  * Patterns: bold Q/A markers, plain Q:/A: lines, Question/Answer labels.
//  */
// function protectQaPairs(markdown) {
//   const blocks = [];
//   let text = String(markdown || "");

//   // Bold Q/A blocks
//   text = text.replace(
//     /(\*\*Q[:?]?\*\*[^\n]*(?:\n(?!\*\*Q[:?]?\*\*)[^\n]*)*)(\n\*\*A[:?]?\*\*[^\n]*(?:\n(?!\*\*[QA][:?]?\*\*)[^\n]*)*)/gi,
//     (match) => {
//       const idx = blocks.length;
//       blocks.push(match);
//       return `\n\n@@QA_BLOCK_${idx}@@\n\n`;
//     },
//   );

//   // Plain Q:/A: lines
//   text = text.replace(
//     /(^|\n)(Q[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)(\nA[:)]\s*[^\n]+(?:\n(?!Q[:)]|A[:)])[^\n]*)*)/gi,
//     (match, lead, q, a) => {
//       const idx = blocks.length;
//       blocks.push(`${q}${a}`);
//       return `${lead}@@QA_BLOCK_${idx}@@`;
//     },
//   );

//   // Question: / Answer: labels (common FAQ markdown)
//   text = text.replace(
//     /(^|\n)((?:Question|Q)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)(\n(?:Answer|A)\s*:\s*[^\n]+(?:\n(?!(?:Question|Answer|Q|A)\s*:)[^\n]*)*)/gi,
//     (match, lead, q, a) => {
//       const idx = blocks.length;
//       blocks.push(`${q}${a}`);
//       return `${lead}@@QA_BLOCK_${idx}@@`;
//     },
//   );

//   return {
//     text,
//     restore: (s) =>
//       String(s || "").replace(/@@QA_BLOCK_(\d+)@@/g, (_, n) => blocks[Number(n)] || ""),
//   };
// }

// /**
//  * Keep product "Details" attribute blocks together when possible.
//  */
// function protectProductBlocks(markdown) {
//   const blocks = [];
//   let text = String(markdown || "");

//   text = text.replace(
//     /(^|\n)(#{1,3}\s*Details\b[^\n]*\n(?:[-*]\s+[^\n]+\n?)+)/gi,
//     (match, lead, block) => {
//       const idx = blocks.length;
//       blocks.push(block.trim());
//       return `${lead}@@PRODUCT_BLOCK_${idx}@@\n`;
//     },
//   );

//   return {
//     text,
//     restore: (s) =>
//       String(s || "").replace(
//         /@@PRODUCT_BLOCK_(\d+)@@/g,
//         (_, n) => blocks[Number(n)] || "",
//       ),
//   };
// }

// /**
//  * True when a section's own heading (first line) is a bullet-list section
//  * we want to split at item boundaries rather than raw chars — currently
//  * just "Products" (PLP listings), written generically so any similarly
//  * shaped list section benefits without hardcoding entity_type checks here.
//  */
// const LIST_SECTION_HEADING_RE = /^#{1,6}\s*(products|items)\b/i;

// /**
//  * Split a heading + bullet-list section into multiple chunks, each capped
//  * near chunkSize, breaking only on whole bullet lines. Unlike the generic
//  * RecursiveCharacterTextSplitter (whose separator fallback chain ends in
//  * " " and ""), this never cuts a "- Name — Price — URL" line in half, and
//  * a long product list becomes several complete sub-lists instead of one
//  * chunk that's arbitrarily sliced or one giant chunk that ignores chunkSize.
//  */
// function splitListSection(text, chunkSize) {
//   const lines = String(text || "").split(/\r?\n/);
//   const isBullet = (l) => /^\s*[-*]\s+/.test(l);

//   // Preamble = heading line(s) + anything before the first bullet (kept at
//   // the top of every resulting chunk so each one is self-describing).
//   let i = 0;
//   const preambleLines = [];
//   while (i < lines.length && !isBullet(lines[i])) {
//     preambleLines.push(lines[i]);
//     i += 1;
//   }
//   const preamble = preambleLines.join("\n").trim();

//   const chunks = [];
//   let current = [];
//   let size = preamble.length;

//   const flush = () => {
//     if (!current.length) return;
//     const body = [preamble, ...current].filter(Boolean).join("\n").trim();
//     if (body) chunks.push(body);
//     current = [];
//     size = preamble.length;
//   };

//   for (; i < lines.length; i += 1) {
//     const line = lines[i];
//     if (!line.trim()) continue;
//     const lineLen = line.length + 1;
//     if (current.length && size + lineLen > chunkSize) flush();
//     current.push(line);
//     size += lineLen;
//   }
//   flush();

//   return chunks.length ? chunks : [text.trim()].filter(Boolean);
// }

// function cleanHeadingTitle(raw) {
//   return String(raw || "")
//     .replace(/[#*_`]/g, "")
//     .trim();
// }

// /**
//  * Split markdown into heading sections with breadcrumb paths.
//  * @returns {{ heading_path: string, text: string, level: number }[]}
//  */
// function splitByHeadings(markdown) {
//   const lines = String(markdown || "").split(/\r?\n/);
//   const sections = [];
//   const stack = []; // { level, title }
//   let buf = [];
//   let currentPath = "";
//   let currentLevel = 0;

//   const flush = () => {
//     const body = buf.join("\n").trim();
//     buf = [];
//     if (!body) return;
//     sections.push({
//       heading_path: currentPath,
//       text: body,
//       level: currentLevel,
//     });
//   };

//   for (const line of lines) {
//     const m = line.match(HEADING_RE);
//     if (m) {
//       flush();
//       const level = m[1].length;
//       const title = cleanHeadingTitle(m[2]);
//       while (stack.length && stack[stack.length - 1].level >= level) {
//         stack.pop();
//       }
//       stack.push({ level, title });
//       currentPath = stack.map((s) => s.title).filter(Boolean).join(" > ");
//       currentLevel = level;
//       buf.push(line);
//     } else {
//       buf.push(line);
//     }
//   }
//   flush();

//   if (sections.length === 0 && String(markdown || "").trim()) {
//     return [
//       {
//         heading_path: "",
//         text: String(markdown).trim(),
//         level: 0,
//       },
//     ];
//   }
//   return sections;
// }

// async function recursiveSplit(text, { chunkSize, chunkOverlap }) {
//   const splitter = new RecursiveCharacterTextSplitter({
//     chunkSize,
//     chunkOverlap,
//     separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
//   });
//   const docs = await splitter.createDocuments([text]);
//   return docs.map((d) => d.pageContent);
// }

// /**
//  * Structure-aware chunking, optionally tuned by section entity_type:
//  * - faq: stronger Q/A protection
//  * - product: keep Details attribute blocks together
//  * - policy/review/general: heading + paragraph splits
//  *
//  * @returns {Promise<{ text: string, heading_path: string }[]>}
//  */
// async function structureAwareChunk(markdown, options = {}) {
//   const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_CHARS;
//   const chunkOverlap = options.chunkOverlap ?? DEFAULT_OVERLAP_CHARS;
//   const entityType = String(options.entity_type || options.pageType || "general")
//     .toLowerCase()
//     .trim();

//   const code = protectCodeBlocks(markdown);
//   let working = code.text;
//   const restorers = [];

//   if (entityType === "faq") {
//     const qa = protectQaPairs(working);
//     working = qa.text;
//     restorers.push(qa.restore);
//   } else if (entityType === "product" || entityType === "listing") {
//     const product = protectProductBlocks(working);
//     working = product.text;
//     restorers.push(product.restore);
//     // Light Q/A protect in case PDP embeds mini-FAQ not split out
//     const qa = protectQaPairs(working);
//     working = qa.text;
//     restorers.push(qa.restore);
//   } else {
//     const qa = protectQaPairs(working);
//     working = qa.text;
//     restorers.push(qa.restore);
//   }

//   const restoreAll = (s) => {
//     let out = s;
//     for (let i = restorers.length - 1; i >= 0; i--) {
//       out = restorers[i](out);
//     }
//     return code.restore(out);
//   };

//   const sections = splitByHeadings(working);
//   const out = [];

//   for (const section of sections) {
//     const restored = restoreAll(section.text).trim();
//     if (!restored) continue;

//     // FAQ: prefer not splitting a single protected Q/A unit further when small
//     if (entityType === "faq" && restored.length <= chunkSize * 1.25) {
//       out.push({
//         text: restored,
//         heading_path: section.heading_path || "",
//       });
//       continue;
//     }

//     if (restored.length <= chunkSize) {
//       out.push({
//         text: restored,
//         heading_path: section.heading_path || "",
//       });
//       continue;
//     }

//     // A long "## Products" / "## Items" section: split at bullet-line
//     // boundaries so a 60-item listing becomes several complete sub-lists
//     // instead of being cut mid-line by the generic char-based splitter.
//     if (LIST_SECTION_HEADING_RE.test(restored)) {
//       const listParts = splitListSection(restored, chunkSize);
//       for (const text of listParts) {
//         if (!text) continue;
//         out.push({ text, heading_path: section.heading_path || "" });
//       }
//       continue;
//     }

//     const parts = await recursiveSplit(restored, { chunkSize, chunkOverlap });
//     for (const part of parts) {
//       const text = part.trim();
//       if (!text) continue;
//       out.push({
//         text,
//         heading_path: section.heading_path || "",
//       });
//     }
//   }

//   if (out.length === 0 && String(markdown || "").trim()) {
//     const parts = await recursiveSplit(String(markdown).trim(), {
//       chunkSize,
//       chunkOverlap,
//     });
//     return parts
//       .map((t) => ({ text: t.trim(), heading_path: "" }))
//       .filter((c) => c.text);
//   }

//   return out;
// }

// module.exports = {
//   structureAwareChunk,
//   splitByHeadings,
//   splitListSection,
//   protectCodeBlocks,
//   protectQaPairs,
//   protectProductBlocks,
//   DEFAULT_CHUNK_CHARS,
//   DEFAULT_OVERLAP_CHARS,
// };





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

/**
 * True when a section's own heading (first line) is a bullet-list section
 * we want to split at item boundaries rather than raw chars — currently
 * just "Products" (PLP listings), written generically so any similarly
 * shaped list section benefits without hardcoding entity_type checks here.
 */
const LIST_SECTION_HEADING_RE = /^#{1,6}\s*(products|items)\b/i;

/**
 * Split a heading + bullet-list section into multiple chunks, each capped
 * near chunkSize, breaking only on whole bullet lines. Unlike the generic
 * RecursiveCharacterTextSplitter (whose separator fallback chain ends in
 * " " and ""), this never cuts a "- Name — Price — URL" line in half, and
 * a long product list becomes several complete sub-lists instead of one
 * chunk that's arbitrarily sliced or one giant chunk that ignores chunkSize.
 */
function splitListSection(text, chunkSize) {
  const lines = String(text || "").split(/\r?\n/);
  const isBullet = (l) => /^\s*[-*]\s+/.test(l);

  // Preamble = heading line(s) + anything before the first bullet (kept at
  // the top of every resulting chunk so each one is self-describing).
  let i = 0;
  const preambleLines = [];
  while (i < lines.length && !isBullet(lines[i])) {
    preambleLines.push(lines[i]);
    i += 1;
  }
  const preamble = preambleLines.join("\n").trim();

  const chunks = [];
  let current = [];
  let size = preamble.length;

  const flush = () => {
    if (!current.length) return;
    const body = [preamble, ...current].filter(Boolean).join("\n").trim();
    if (body) chunks.push(body);
    current = [];
    size = preamble.length;
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lineLen = line.length + 1;
    if (current.length && size + lineLen > chunkSize) flush();
    current.push(line);
    size += lineLen;
  }
  flush();

  return chunks.length ? chunks : [text.trim()].filter(Boolean);
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

    // A long "## Products" / "## Items" section: split at bullet-line
    // boundaries so a 60-item listing becomes several complete sub-lists
    // instead of being cut mid-line by the generic char-based splitter.
    if (LIST_SECTION_HEADING_RE.test(restored)) {
      const listParts = splitListSection(restored, chunkSize);
      for (const text of listParts) {
        if (!text) continue;
        out.push({ text, heading_path: section.heading_path || "" });
      }
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

module.exports = {
  structureAwareChunk,
  splitByHeadings,
  splitListSection,
  protectCodeBlocks,
  protectQaPairs,
  protectProductBlocks,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
};