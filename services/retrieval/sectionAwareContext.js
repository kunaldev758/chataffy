/**
 * Section-aware context helpers: group by URL, preserve entity_type boundaries.
 */

function payloadOf(m) {
  return m?.payload || m || {};
}

/**
 * Group matches by URL, then by entity_type order preference.
 */
function groupMatchesByUrlAndEntity(matches = [], preferredEntityOrder = []) {
  const byUrl = new Map();

  for (const m of matches) {
    const p = payloadOf(m);
    const url = p.url || "unknown";
    if (!byUrl.has(url)) {
      byUrl.set(url, {
        url,
        title: p.title || url,
        byEntity: new Map(),
      });
    }
    const bucket = byUrl.get(url);
    const et = String(p.entity_type || "general").toLowerCase();
    if (!bucket.byEntity.has(et)) {
      bucket.byEntity.set(et, {
        entity_type: et,
        entity_name: p.entity_name || null,
        pageType: p.pageType || null,
        chunks: [],
      });
    }
    bucket.byEntity.get(et).chunks.push(m);
  }

  const orderIndex = (et) => {
    const i = preferredEntityOrder.indexOf(et);
    return i === -1 ? 100 : i;
  };

  return [...byUrl.values()].map((page) => {
    const sections = [...page.byEntity.values()].sort(
      (a, b) => orderIndex(a.entity_type) - orderIndex(b.entity_type),
    );
    return {
      url: page.url,
      title: page.title,
      sections,
    };
  });
}

function selectRelevantSectionsForIntent(sections, strategy = {}) {
  const primary = strategy.primaryEntity
    ? String(strategy.primaryEntity).toLowerCase()
    : null;
  const preferred =
    strategy.preferredEntityTypes?.length > 0
      ? strategy.preferredEntityTypes
      : strategy.softEntityTypes || [];

  if (!preferred.length && !primary) return sections;

  const preferredSet = new Set(
    [...(primary ? [primary] : []), ...preferred].map((t) => t.toLowerCase()),
  );

  // Product-detail: keep product (+ faq/review on same page), drop listing sections
  if (primary === "product" || strategy.mode === "product_detail") {
    const keep = sections.filter((s) =>
      ["product", "faq", "review", "policy"].includes(s.entity_type),
    );
    if (keep.length) return keep;
  }

  // Catalog: prefer listing; allow product as secondary
  if (primary === "listing" || strategy.mode === "catalog_list") {
    const listing = sections.filter((s) => s.entity_type === "listing");
    if (listing.length) return listing;
    const products = sections.filter((s) => s.entity_type === "product");
    if (products.length) return products;
  }

  const matched = sections.filter((s) => preferredSet.has(s.entity_type));
  const extras = sections.filter((s) =>
    ["faq", "policy", "review"].includes(s.entity_type),
  );

  const byType = new Map();
  for (const s of [...matched, ...extras]) {
    byType.set(s.entity_type, s);
  }
  return byType.size ? [...byType.values()] : sections;
}

/**
 * Render section-aware text blocks for the LLM.
 */
function buildSectionAwareContextBlocks(matches, strategy = {}, options = {}) {
  const maxChars = options.maxTotalChars ?? 6000;
  const maxChunkChars = options.maxChunkChars ?? 1200;
  const pages = groupMatchesByUrlAndEntity(
    matches,
    strategy.preferredEntityTypes || strategy.softEntityTypes || [],
  );

  const blocks = [];
  let used = 0;

  for (const page of pages) {
    if (used >= maxChars) break;
    const sections = selectRelevantSectionsForIntent(page.sections, strategy);
    if (!sections.length) continue;

    const parts = [`Source: ${page.title}`, `URL: ${page.url}`];

    for (const section of sections) {
      parts.push(
        `\n### [${section.entity_type}]${
          section.entity_name ? ` ${section.entity_name}` : ""
        }`,
      );
      const sorted = [...section.chunks].sort((a, b) => {
        const ia = payloadOf(a).chunk_index ?? 0;
        const ib = payloadOf(b).chunk_index ?? 0;
        return ia - ib;
      });
      for (const chunk of sorted) {
        const text = String(payloadOf(chunk).text || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxChunkChars);
        if (!text) continue;
        const heading = payloadOf(chunk).heading_path;
        parts.push(heading ? `(${heading}) ${text}` : text);
      }
    }

    const block = parts.join("\n").trim();
    if (!block) continue;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length;
  }

  return blocks.join("\n\n---\n\n");
}

module.exports = {
  groupMatchesByUrlAndEntity,
  selectRelevantSectionsForIntent,
  buildSectionAwareContextBlocks,
};
