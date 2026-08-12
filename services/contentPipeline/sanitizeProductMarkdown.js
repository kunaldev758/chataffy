/**
 * Product/PDP-only markdown sanitizer for RAG.
 * Strips Shopify implementation JSON (objects + variant arrays), base64 maps,
 * all image/CDN noise, theme CSS, and obvious nav/UI chrome.
 *
 * Do NOT use on blogs/docs/generic/readability pages.
 *
 * Pipeline (when called from extractProductContent with PDP_RAG_CLEANUP):
 *   removeShopifyJsonBlobs → removeOrphanedShopifyFragments →
 *   removeEncodedVariantNoise → removeImageNoise → removeShopifyCssBlocks →
 *   removePdpChrome → dedupeRepeatedShortBlocks → normalizeWhitespace
 */

const SHOPIFY_IMPL_KEYS = [
  "variants",
  "product_id",
  "inventory_quantity",
  "inventory_management",
  "inventory_policy",
  "selling_plan_allocations",
  "quantity_rule",
  "preview_image",
  "featured_image",
  "featured_media",
  "requires_selling_plan",
  "media",
  "variant_options",
  "variant_id",
  "compare_at_price",
  "price_varies",
  "compare_at_price_varies",
  "requires_shipping",
  "variant_ids",
];

/** Keys that strongly indicate a Shopify variant row */
const VARIANT_ROW_KEYS = [
  "featured_image",
  "featured_media",
  "option1",
  "inventory_management",
  "selling_plan_allocations",
  "quantity_rule",
  "requires_shipping",
  "public_title",
  "variant_ids",
];

const STRONG_SHOPIFY_KEYS = [
  "variants",
  "featured_image",
  "featured_media",
  "selling_plan_allocations",
  "inventory_management",
  "product_id",
  "media",
  "variant_options",
  "requires_selling_plan",
];

const SUPPORT_SHOPIFY_KEYS = [
  "option1",
  "option2",
  "requires_shipping",
  "quantity_rule",
  "compare_at_price",
  "public_title",
  "inventory_quantity",
  "variant_ids",
  "preview_image",
  "price_varies",
  "compare_at_price_varies",
  "available",
  "sku",
];

const DIRTY_MAX_SPAN = 280000;

const KEY_HINT_RE =
  /"(?:variants|product_id|inventory_quantity|featured\\?_image|featured\\?_media|selling\\?_plan\\?_allocations|variant_options|inventory\\?_management|requires\\?_shipping|quantity\\?_rule|option1|media|images)"\s*:/i;

const IMAGE_EXT_RE =
  /\.(?:webp|jpe?g|png|gif|svg|avif|bmp|ico|tiff?)(?:\?[^)\s\]>"']*)?/i;

const SAFE_PROSE_BOUNDARY_RE =
  /\n{2,}(?:#{1,6}\s+|Engineer|FAQ|Details|Description|Care\b|Shipping\b|Size guide)/i;

function looksLikeShopifyImplObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  let hits = 0;
  for (const k of keys) {
    const lk = String(k).toLowerCase();
    if (SHOPIFY_IMPL_KEYS.some((sk) => lk === sk || lk.includes(sk))) hits += 1;
  }
  if (hits >= 2) return true;
  if (
    hits >= 1 &&
    (Array.isArray(obj.variants) ||
      obj.featured_image ||
      obj.featured_media ||
      obj.media ||
      obj.variant_options)
  ) {
    return true;
  }
  if (
    (obj.product_id != null || obj.variant_id != null) &&
    (obj.variant_options || obj.inventory_quantity != null || obj.image)
  ) {
    return true;
  }
  if (looksLikeShopifyVariantRow(obj)) return true;
  return false;
}

function looksLikeShopifyVariantRow(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let hits = 0;
  for (const k of Object.keys(obj)) {
    const lk = String(k).toLowerCase();
    if (VARIANT_ROW_KEYS.some((sk) => lk === sk)) hits += 1;
  }
  if (hits >= 2) return true;
  if (
    (obj.sku || obj.title || obj.name) &&
    obj.price != null &&
    (obj.featured_image ||
      obj.featured_media ||
      obj.option1 != null ||
      obj.inventory_management)
  ) {
    return true;
  }
  return false;
}

function looksLikeShopifyImplArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return false;
  const sample = arr.slice(0, 5);
  const hits = sample.filter((item) => looksLikeShopifyVariantRow(item)).length;
  return hits >= 1 || (sample.length >= 2 && hits / sample.length >= 0.4);
}

/**
 * Normalize markdown-escaped / entity-escaped JSON for detection only.
 * Never write this back into content.
 */
function normalizeJsonish(raw) {
  return String(raw || "")
    .replace(/\\_/g, "_")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Build normalized text + index map so deletions apply to the original span.
 * map[normIdx] = origIdx; map[norm.length] = orig.length (exclusive end).
 */
function normalizeJsonishWithMap(raw) {
  const s = String(raw || "");
  let out = "";
  const map = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && (s[i + 1] === "_" || s[i + 1] === "/")) {
      map.push(i);
      out += s[i + 1] === "_" ? "_" : "/";
      i += 2;
      continue;
    }
    if (s[i] === "\\" && s[i + 1] === '"') {
      map.push(i);
      out += '"';
      i += 2;
      continue;
    }
    if (s.slice(i, i + 5).toLowerCase() === "&amp;") {
      map.push(i);
      out += "&";
      i += 5;
      continue;
    }
    if (s.slice(i, i + 6).toLowerCase() === "&quot;") {
      map.push(i);
      out += '"';
      i += 6;
      continue;
    }
    if (s.slice(i, i + 5) === "&#39;") {
      map.push(i);
      out += "'";
      i += 5;
      continue;
    }
    map.push(i);
    out += s[i];
    i += 1;
  }
  map.push(s.length);
  return { text: out, map };
}

function countKeyHits(haystack, keys) {
  const s = String(haystack || "");
  let hits = 0;
  for (const key of keys) {
    const re = new RegExp(
      `"${key.replace(/_/g, "\\\\?_")}"\\s*:`,
      "i",
    );
    if (re.test(s) || s.includes(`"${key}"`)) hits += 1;
  }
  return hits;
}

/**
 * ≥3 strong OR (≥2 strong AND ≥2 support)
 */
function scoreShopifySignals(raw) {
  const s = normalizeJsonish(String(raw || "").slice(0, 12000));
  const strong = countKeyHits(s, STRONG_SHOPIFY_KEYS);
  const support = countKeyHits(s, SUPPORT_SHOPIFY_KEYS);
  const high =
    strong >= 3 || (strong >= 2 && support >= 2) || (strong >= 1 && support >= 3);
  return { strong, support, high, score: strong * 2 + support };
}

function looksLikeShopifyImplRaw(raw) {
  const s = String(raw || "");
  if (s.length < 40) return false;
  return scoreShopifySignals(s).high || scoreShopifySignals(s).strong >= 2;
}

function tryParseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(normalizeJsonish(raw));
    } catch {
      return null;
    }
  }
}

/**
 * Balanced `{...}` or `[...]` scanner; respects strings/escapes.
 */
function extractBalancedJson(text, startIdx) {
  if (!text || startIdx < 0 || startIdx >= text.length) return null;
  const open = text[startIdx];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  const limit = Math.min(text.length, startIdx + 600000);

  for (let i = startIdx; i < limit; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        return { start: startIdx, end: i + 1, raw: text.slice(startIdx, i + 1) };
      }
    }
  }
  return null;
}

function shouldRemoveJsonBlob(raw) {
  const parsed = tryParseJson(raw);
  if (parsed) {
    if (Array.isArray(parsed)) return looksLikeShopifyImplArray(parsed);
    return looksLikeShopifyImplObject(parsed);
  }
  return looksLikeShopifyImplRaw(raw);
}

/**
 * Candidate openers before a key hit (nearest → outermost in window).
 */
function collectJsonStartsBefore(text, keyIdx) {
  const starts = [];
  for (let i = keyIdx; i >= 0; i--) {
    const c = text[i];
    if (c === "{" || c === "[") starts.push(i);
    if (c === "\n" && keyIdx - i > 12000) break;
    if (keyIdx - i > 40000) break;
  }
  return starts;
}

/**
 * Prefer outermost Shopify object over inner variants arrays so we don't leave
 * `"variants":\` orphans inside a half-deleted product dump.
 */
function findBestRemovableBlob(text, absKeyIdx) {
  const starts = collectJsonStartsBefore(text, absKeyIdx);
  let best = null;

  for (const start of starts) {
    const found = extractBalancedJson(text, start);
    if (!found) continue;
    if (!shouldRemoveJsonBlob(found.raw)) continue;
    if (
      !best ||
      found.start < best.start ||
      (found.start === best.start && found.end > best.end)
    ) {
      best = found;
    }
  }

  if (best) return best;

  // Normalized structural scan: parse/score on copy, delete original span
  for (const start of starts.slice(0, 8)) {
    const windowEnd = Math.min(text.length, start + DIRTY_MAX_SPAN);
    const slice = text.slice(start, windowEnd);
    const { text: norm, map } = normalizeJsonishWithMap(slice);
    if (norm[0] !== "{" && norm[0] !== "[") continue;
    const foundNorm = extractBalancedJson(norm, 0);
    if (!foundNorm) continue;
    if (!shouldRemoveJsonBlob(foundNorm.raw)) continue;
    const origStart = start + map[foundNorm.start];
    const origEnd = start + map[foundNorm.end];
    return {
      start: origStart,
      end: origEnd,
      raw: text.slice(origStart, origEnd),
    };
  }

  // Bounded dirty fallback: high-confidence Shopify dump that won't balance
  for (const start of starts.slice(0, 4)) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const dirty = findDirtyShopifySpan(text, start);
    if (dirty) return dirty;
  }

  return null;
}

function findDirtyShopifySpan(text, start) {
  const maxEnd = Math.min(text.length, start + DIRTY_MAX_SPAN);
  let end = maxEnd;
  const after = text.slice(start, maxEnd);
  const boundary = SAFE_PROSE_BOUNDARY_RE.exec(after);
  if (boundary && boundary.index > 80) {
    end = start + boundary.index;
  }

  let raw = text.slice(start, end);
  // Prefer ending on last closing brace/bracket in the window
  const lastClose = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (lastClose > 80) {
    raw = raw.slice(0, lastClose + 1);
    end = start + lastClose + 1;
  }

  if (raw.length < 80) return null;
  const scored = scoreShopifySignals(raw);
  if (!scored.high && scored.strong < 2) return null;
  // Don't eat short prose mistakenly — need JSON-ish density
  const braceDensity =
    ((raw.match(/[{}\[\]":]/g) || []).length) / Math.max(raw.length, 1);
  if (braceDensity < 0.02 && scored.strong < 3) return null;

  return { start, end, raw };
}

function removeShopifyJsonBlobs(text) {
  let out = String(text || "");
  let removed = 0;
  let searchFrom = 0;
  let guard = 0;

  while (guard++ < 120) {
    const slice = out.slice(searchFrom);
    const keyHint = KEY_HINT_RE.exec(slice);
    if (!keyHint) break;

    const absKeyIdx = searchFrom + keyHint.index;
    const best = findBestRemovableBlob(out, absKeyIdx);
    if (!best) {
      searchFrom = absKeyIdx + keyHint[0].length;
      continue;
    }

    out = `${out.slice(0, best.start)}\n${out.slice(best.end)}`;
    removed += 1;
    searchFrom = best.start;
  }

  return { text: out, removed };
}

/**
 * Clean wreckage left by partial JSON deletes (e.g. `"variants":\`).
 */
function removeOrphanedShopifyFragments(text) {
  let out = String(text || "");
  let removed = 0;

  const patterns = [
    /"(?:variants|media|images|featured\\?_image|featured\\?_media|selling\\?_plan\\?_allocations|variant_options|options)"\s*:\s*\\?\s*,?/gi,
    /"(?:product_id|variant_id|inventory_quantity|requires\\?_shipping|price_varies)"\s*:\s*\\?\s*(?:null|true|false|\d+)?\s*,?/gi,
    /,\s*,+/g,
    /\{\s*,/g,
    /\[\s*,/g,
    /,\s*([}\]])/g,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const before = out;
    if (i < 2) {
      out = out.replace(patterns[i], () => {
        removed += 1;
        return "";
      });
    } else if (i === 5) {
      out = out.replace(patterns[i], "$1");
      if (out !== before) removed += 1;
    } else {
      out = out.replace(patterns[i], (m) => {
        if (m.startsWith("{")) return "{";
        if (m.startsWith("[")) return "[";
        return ",";
      });
      if (out !== before) removed += 1;
    }
  }

  // Drop near-empty leftover object/array shells
  out = out.replace(/\{\s*\}/g, () => {
    removed += 1;
    return "";
  });
  out = out.replace(/\[\s*\]/g, () => {
    removed += 1;
    return "";
  });

  return { text: out, removed };
}

function isBase64yToken(token) {
  const t = String(token || "").trim();
  if (t.length < 24 || t.length > 4000) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(t)) return false;
  if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/[0-9]/.test(t)) return false;
  if (/^(https?:|www\.)/i.test(t)) return false;
  return true;
}

function removeEncodedVariantNoise(text) {
  let out = String(text || "");
  let removed = 0;

  out = out
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (
        /"variant_options"\s*:|"product_id"\s*:\s*"[A-Za-z0-9+/=]{8,}"/.test(
          trimmed,
        )
      ) {
        removed += 1;
        return false;
      }
      if (isBase64yToken(trimmed) && trimmed.length >= 40) {
        removed += 1;
        return false;
      }
      return true;
    })
    .join("\n");

  out = out.replace(
    /("(?:product_id|variant_id|variant_available|inventory_quantity|inventory_management|inventory_policy|image|price|title|value|Color|Size)"\s*:\s*")([A-Za-z0-9+/=_-]{24,})(")/g,
    (m, a, tok, c) => {
      if (isBase64yToken(tok)) {
        removed += 1;
        return `${a}${c}`;
      }
      return m;
    },
  );

  return { text: out, removed };
}

/**
 * Strip every image form from semantic PDP markdown.
 */
function removeImageNoise(text) {
  let out = String(text || "");
  let removed = 0;

  if (/&amp;|&quot;/i.test(out)) {
    out = out.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"');
  }

  out = out.replace(/!\[[^\]]*]\([^)]+\)/g, () => {
    removed += 1;
    return "";
  });

  out = out.replace(/<img\b[^>]*>/gi, () => {
    removed += 1;
    return "";
  });

  out = out.replace(/^Image\s*\([^)]*\)\s*$/gim, () => {
    removed += 1;
    return "";
  });
  out = out.replace(/\bImage\s*\([^)]+\)\s*:?\s*/gi, () => {
    removed += 1;
    return "";
  });

  out = out.replace(
    /(?:https?:)?\/\/(?:cdn\.shopify\.com|(?:[^\s)\]>"']+\/)?cdn\/shop)[^\s)\]>"']+/gi,
    () => {
      removed += 1;
      return "";
    },
  );

  out = out.replace(/https?:\/\/[^\s)\]>"']+/gi, (url) => {
    if (IMAGE_EXT_RE.test(url) || /\/cdn\/shop\//i.test(url)) {
      removed += 1;
      return "";
    }
    return url;
  });

  out = out.replace(
    /\/\/[^\s)\]>"']+\.(?:webp|jpe?g|png|gif|svg|avif)(?:\?[^\s)\]>"']*)?/gi,
    () => {
      removed += 1;
      return "";
    },
  );

  return { text: out, removed };
}

function removeShopifyCssBlocks(text) {
  let out = String(text || "");
  let removed = 0;
  out = out.replace(
    /#shopify-section-[^{\n]+\{[^}]*\}(?:\s*#shopify-section-[^{\n]+\{[^}]*\})*/gi,
    () => {
      removed += 1;
      return "";
    },
  );
  out = out.replace(
    /@media[^{]+\{[\s\S]*?#shopify-section-[\s\S]*?\}\s*\}/gi,
    () => {
      removed += 1;
      return "";
    },
  );
  return { text: out, removed };
}

const CHROME_LINE_PATTERNS = [
  /^your cart is empty\b/i,
  /^continue shopping\b/i,
  /^skip to content\b/i,
  /^clear\s+close\b/i,
  /^search\s*$/i,
  /^share\s*$/i,
  /^zoom\s*$/i,
  /^×\s*$/,
  /^x\s*$/i,
  /^add to cart\s*$/i,
  /^buy (it|now)\s*$/i,
  /^sold out\s*$/i,
  /^check delivery status\b/i,
  /^looking for corporate\b/i,
  /^exclusive offers?\s*$/i,
  /^you may also like\s*$/i,
  /^related products?\s*$/i,
  /^customers? also bought\s*$/i,
  /^complete the look\s*$/i,
  /^apply coupon\s*$/i,
  /^use code\b/i,
  /^get \d+%\s*off\b/i,
  /^free shipping\s*$/i,
];

/**
 * Line-level PDP chrome only — never strip "add to cart" inside real prose.
 */
function removePdpChrome(text) {
  const lines = String(text || "").split("\n");
  const kept = [];
  let removed = 0;
  let relatedStreak = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      relatedStreak = 0;
      continue;
    }

    if (CHROME_LINE_PATTERNS.some((re) => re.test(trimmed))) {
      removed += 1;
      continue;
    }
    if (
      /^(cart|menu|wishlist|account|login|register|sign in)\s*$/i.test(trimmed)
    ) {
      removed += 1;
      continue;
    }
    if (
      /^(cash on delivery|secure payment|14 days? free return)/i.test(trimmed)
    ) {
      removed += 1;
      continue;
    }

    // Related-product / offer clusters: short link-only or price-only lines
    const isShortLink =
      /^\[.{0,80}]\(https?:\/\/[^)]+\)\s*$/i.test(trimmed) &&
      trimmed.length < 120;
    const isBarePrice = /^₹?\s?\d[\d,]*(\.\d+)?\s*$/.test(trimmed);
    const isRelatedHeading =
      /^(you may also like|related|recommended|more from|pairs? well)/i.test(
        trimmed,
      );

    if (isRelatedHeading) {
      removed += 1;
      relatedStreak = 2;
      continue;
    }
    if (relatedStreak > 0 && (isShortLink || isBarePrice || trimmed.length < 40)) {
      removed += 1;
      relatedStreak += 1;
      if (relatedStreak > 12) relatedStreak = 0;
      continue;
    }
    relatedStreak = 0;

    kept.push(line);
  }

  return { text: kept.join("\n"), removed };
}

/** @deprecated use removePdpChrome — kept for callers/tests that expect the name */
function removeNavUiNoise(text) {
  return removePdpChrome(text);
}

function normalizeBlockKey(part) {
  return part
    .toLowerCase()
    .replace(/[!\[\]\(\)*_`#>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isShortFeatureHeading(norm) {
  return (
    /^\d{1,2}\s+\S/.test(norm) ||
    (norm.length > 0 &&
      norm.length <= 60 &&
      !norm.includes(".") &&
      norm.split(" ").length <= 8)
  );
}

/**
 * Dedupe long blocks (≥80) and repeated short feature headings (01–05 etc.).
 */
function dedupeRepeatedShortBlocks(text) {
  const parts = String(text || "").split(/\n{2,}/);
  const seenLong = new Set();
  const seenShort = new Set();
  const kept = [];
  let removed = 0;

  for (const part of parts) {
    const norm = normalizeBlockKey(part);
    if (!norm) {
      kept.push(part);
      continue;
    }

    if (norm.length >= 80) {
      if (seenLong.has(norm)) {
        removed += 1;
        continue;
      }
      seenLong.add(norm);
      kept.push(part);
      continue;
    }

    if (isShortFeatureHeading(norm)) {
      if (seenShort.has(norm)) {
        removed += 1;
        continue;
      }
      seenShort.add(norm);
    }

    kept.push(part);
  }

  return {
    text: kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(),
    removed,
  };
}

function dedupeExactBlocks(text) {
  return dedupeRepeatedShortBlocks(text);
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} text
 * @param {{ dedupe?: boolean }} [opts]
 * @returns {{ text: string, stats: object }}
 */
function sanitizeProductMarkdown(text, opts = {}) {
  const input = String(text || "");
  if (!input.trim()) {
    return {
      text: "",
      stats: {
        hadJsonBlob: false,
        hadImages: false,
        removedJson: 0,
        removedOrphans: 0,
        removedImages: 0,
        removedCss: 0,
        removedUi: 0,
        removedEncoded: 0,
        removedDupes: 0,
      },
    };
  }

  let out = input;
  const json = removeShopifyJsonBlobs(out);
  out = json.text;
  const orphans = removeOrphanedShopifyFragments(out);
  out = orphans.text;
  const encoded = removeEncodedVariantNoise(out);
  out = encoded.text;
  const images = removeImageNoise(out);
  out = images.text;
  const css = removeShopifyCssBlocks(out);
  out = css.text;
  const ui = removePdpChrome(out);
  out = ui.text;

  let removedDupes = 0;
  if (opts.dedupe !== false) {
    const deduped = dedupeRepeatedShortBlocks(out);
    out = deduped.text;
    removedDupes = deduped.removed;
  }

  out = normalizeWhitespace(out);

  return {
    text: out,
    stats: {
      hadJsonBlob: json.removed > 0,
      hadImages: images.removed > 0,
      removedJson: json.removed,
      removedOrphans: orphans.removed,
      removedImages: images.removed,
      removedCss: css.removed,
      removedUi: ui.removed,
      removedEncoded: encoded.removed,
      removedDupes,
    },
  };
}

function isLowValueResidual(section = {}) {
  const content = String(section.content || "");
  const heading = String(section.entity_name || section.heading || "");
  const combined = `${heading}\n${content}`;
  if (!content.trim()) return true;

  if (
    /you may also like|related products|customers also|recommended|complete the look|recently viewed/i.test(
      combined,
    )
  ) {
    return true;
  }
  if (/#shopify-section-|@media screen/i.test(content)) return true;

  const imageHits = (
    content.match(/!\[[^\]]*]\(|cdn\/shop|\.webp|\.jpe?g|\.png|\.svg/gi) || []
  ).length;
  const linkHits = (content.match(/\[.*?]\(https?:\/\//g) || []).length;
  const words = content.split(/\s+/).filter(Boolean).length;
  if (words > 0 && (imageHits + linkHits) / Math.max(words, 1) > 0.35) {
    return true;
  }
  if (imageHits >= 6 && words < 120) return true;
  if (linkHits >= 8 && words < 150) return true;

  if (
    (content.match(/\{[^}]*\}/g) || []).length >= 3 &&
    /--[a-z-]+:|product-list-/i.test(content)
  ) {
    return true;
  }

  return false;
}

module.exports = {
  sanitizeProductMarkdown,
  isLowValueResidual,
  looksLikeShopifyImplObject,
  looksLikeShopifyVariantRow,
  looksLikeShopifyImplArray,
  scoreShopifySignals,
  dedupeExactBlocks,
  dedupeRepeatedShortBlocks,
  removeShopifyJsonBlobs,
  removeOrphanedShopifyFragments,
  removePdpChrome,
  removeNavUiNoise,
  removeImageNoise,
  extractBalancedJson,
  normalizeJsonish,
};
