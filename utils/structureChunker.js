/**
 * Structure-aware chunking based on entity type.
 */

/**
 * Split markdown text by headers while keeping track of current header path.
 * Respects code blocks (does not split inside a code block).
 * 
 * @param {string} markdown - The markdown content
 * @returns {Array<{ heading: string, path: string, content: string }>}
 */
function splitByHeadings(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  
  let inCodeBlock = false;
  let currentHeaderPath = [];
  let currentHeading = "Introduction";
  let currentLines = [];

  const flushSection = () => {
    const content = currentLines.join("\n").trim();
    if (content || currentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        path: currentHeaderPath.join(" > ") || currentHeading,
        content: content,
      });
    }
    currentLines = [];
  };

  for (const line of lines) {
    // Check if toggle code block
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      currentLines.push(line);
      continue;
    }

    // Check for markdown heading (e.g., #, ##, ###, ####)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushSection();

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Update heading path based on header level
      currentHeaderPath = currentHeaderPath.slice(0, level - 1);
      currentHeaderPath[level - 1] = title;

      currentHeading = title;
      continue;
    }

    currentLines.push(line);
  }

  flushSection();
  return sections;
}

/**
 * Split a large chunk of text into smaller blocks with overlap.
 * 
 * @param {string} text - Clean text
 * @param {number} maxWords - Max words per sub-chunk
 * @param {number} overlapWords - Number of words to overlap
 * @returns {string[]}
 */
function splitTextWithOverlap(text, maxWords = 350, overlapWords = 50) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text];

  const chunks = [];
  let i = 0;

  while (i < words.length) {
    const chunkWords = words.slice(i, i + maxWords);
    chunks.push(chunkWords.join(" "));
    i += (maxWords - overlapWords);
  }

  return chunks;
}

/**
 * FAQ Chunker: Extracts Q/A pairs.
 */
function chunkFaq(markdown) {
  const sections = splitByHeadings(markdown);
  const chunks = [];

  for (const sec of sections) {
    // A section with content under a heading is naturally a Q/A pair
    const q = sec.heading;
    const a = sec.content;
    
    if (q && a) {
      chunks.push({
        text: `Question: ${q}\nAnswer: ${a}`,
        heading_path: sec.path,
      });
    }
  }

  // Fallback if no headings exist: try Q: / A: regex patterns
  if (chunks.length === 0) {
    const qnaRegex = /(?:^|\n)(?:Q|Question):\s*(.*?)(?=\n(?:A|Answer):|\n(?:Q|Question):|$)\n(?:A|Answer):\s*([\s\S]*?)(?=\n(?:Q|Question):|$)/gi;
    let match;
    while ((match = qnaRegex.exec(markdown)) !== null) {
      chunks.push({
        text: `Question: ${match[1].trim()}\nAnswer: ${match[2].trim()}`,
        heading_path: "FAQ",
      });
    }
  }

  // Ultimate fallback if FAQ parsing didn't find clear Q&A structure
  if (chunks.length === 0 && markdown.trim()) {
    chunks.push({
      text: markdown,
      heading_path: "FAQ",
    });
  }

  return chunks;
}

/**
 * Docs/code chunker: splits by heading, ensures code blocks stay atomic.
 */
function chunkDocs(markdown) {
  const sections = splitByHeadings(markdown);
  const chunks = [];

  for (const sec of sections) {
    if (!sec.content) continue;
    
    // Check if section is too large, sub-split it but keep code blocks intact
    if (sec.content.split(/\s+/).length > 600) {
      const subChunks = splitTextWithOverlap(sec.content, 400, 50);
      subChunks.forEach((sub, idx) => {
        chunks.push({
          text: `# ${sec.heading}\n\n${sub}`,
          heading_path: `${sec.path} (Part ${idx + 1})`,
        });
      });
    } else {
      chunks.push({
        text: `# ${sec.heading}\n\n${sec.content}`,
        heading_path: sec.path,
      });
    }
  }

  return chunks;
}

/**
 * Product/listing Chunker: Builds one structured metadata chunk,
 * and splits descriptions into subsequent chunks if long.
 */
function chunkProduct(markdown, attributes, entityName, url) {
  const chunks = [];

  // 1. Build the primary structured product block
  let structuredText = `[PRODUCT DETAILS]\n`;
  if (entityName) structuredText += `Name: ${entityName}\n`;
  if (attributes.price) structuredText += `Price: $${attributes.price}${attributes.currency ? ` ${attributes.currency}` : ""}\n`;
  if (attributes.sku) structuredText += `SKU: ${attributes.sku}\n`;
  
  if (attributes.availability) {
    const avail = attributes.availability === "InStock" ? "In Stock" : 
                  attributes.availability === "OutOfStock" ? "Out of Stock" : attributes.availability;
    structuredText += `Availability: ${avail}\n`;
  }
  
  if (attributes.brand) structuredText += `Brand: ${attributes.brand}\n`;
  if (attributes.category) structuredText += `Category: ${attributes.category}\n`;
  if (url) structuredText += `URL: ${url}\n`;
  
  structuredText += `[END PRODUCT DETAILS]`;

  // First chunk holds the main product details
  chunks.push({
    text: structuredText,
    heading_path: entityName || "Product Specifications",
  });

  // 2. Process long-form description if it exists
  const cleanDesc = (markdown || "").trim();
  if (cleanDesc && cleanDesc.length > 50) {
    // If description has markdown headings, split them
    if (cleanDesc.includes("#")) {
      const descSections = splitByHeadings(cleanDesc);
      for (const sec of descSections) {
        chunks.push({
          text: `Product: ${entityName || "item"}\nDescription (${sec.heading}):\n${sec.content}`,
          heading_path: `${entityName || "Product"} > ${sec.path}`,
        });
      }
    } else {
      // Just split by paragraph/length
      const subChunks = splitTextWithOverlap(cleanDesc, 350, 40);
      subChunks.forEach((sub, idx) => {
        chunks.push({
          text: `Product: ${entityName || "item"}\nDescription:\n${sub}`,
          heading_path: `${entityName || "Product"} > Description${idx > 0 ? ` (Part ${idx + 1})` : ""}`,
        });
      });
    }
  }

  return chunks;
}

/**
 * Generic/blog/policy chunker: heading-based split, sub-split with overlap.
 */
function chunkGeneric(markdown) {
  const sections = splitByHeadings(markdown);
  const chunks = [];

  for (const sec of sections) {
    const wordCount = sec.content.split(/\s+/).length;
    
    if (wordCount > 400) {
      const subChunks = splitTextWithOverlap(sec.content, 350, 45);
      subChunks.forEach((sub, idx) => {
        chunks.push({
          text: `# ${sec.heading}\n\n${sub}`,
          heading_path: `${sec.path} (Part ${idx + 1})`,
        });
      });
    } else {
      chunks.push({
        text: `# ${sec.heading}\n\n${sec.content}`,
        heading_path: sec.path,
      });
    }
  }

  // If splitByHeadings didn't find any segments, just split the raw markdown
  if (chunks.length === 0 && markdown.trim()) {
    const subChunks = splitTextWithOverlap(markdown, 350, 45);
    subChunks.forEach((sub, idx) => {
      chunks.push({
        text: sub,
        heading_path: `General Content (Part ${idx + 1})`,
      });
    });
  }

  return chunks;
}

/**
 * Main chunking entrypoint.
 * 
 * @param {string} markdown - Clean markdown content
 * @param {string} entityType - Classified entity type
 * @param {Object} attributes - Extracted metadata attributes
 * @param {string} entityName - Name of the entity (if any)
 * @param {string} url - Source URL
 * @returns {Array<{ text: string, heading_path: string }>}
 */
function chunkContentByStructure(markdown, entityType, attributes = {}, entityName = "", url = "") {
  if (!markdown || !markdown.trim()) return [];

  switch (entityType) {
    case "faq":
      return chunkFaq(markdown);
    case "docs":
      return chunkDocs(markdown);
    case "product":
      return chunkProduct(markdown, attributes, entityName, url);
    case "listing":
      return chunkGeneric(markdown); // listings can be chunked similarly to generic
    default:
      return chunkGeneric(markdown);
  }
}

module.exports = {
  chunkContentByStructure,
  splitByHeadings,
  splitTextWithOverlap,
};
