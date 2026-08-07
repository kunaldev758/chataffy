/**
 * Validation: deterministic JSON-LD / DOM fields ALWAYS win over LLM output.
 */

const DETERMINISTIC_ATTR_KEYS = new Set([
  "sku",
  "price",
  "original_price",
  "price_min",
  "price_max",
  "currency",
  "in_stock",
  "brand",
  "color",
  "size",
  "variant_id",
  "mpn",
]);

function isEmpty(value) {
  if (value == null) return true;
  if (typeof value === "string" && !value.trim()) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Merge rule + extraction + optional LLM enrichment.
 * @param {object} base - deterministic extraction result
 * @param {object|null} llm - classifyPageTypeLlm result
 */
function applyValidation(base, llm = null) {
  const out = {
    pageType: base.pageType || "generic",
    entity_type: base.entity_type || "general",
    entity_name: base.entity_name ?? null,
    content: base.content || "",
    title: base.title || "",
    metaDescription: base.metaDescription || "",
    canonicalUrl: base.canonicalUrl ?? null,
    language: base.language || "en",
    attributes: {
      ...(base.attributes && typeof base.attributes === "object"
        ? base.attributes
        : {}),
    },
    search_terms: Array.isArray(base.search_terms)
      ? [...base.search_terms]
      : [],
    classification_confidence:
      typeof base.classification_confidence === "number"
        ? base.classification_confidence
        : 0,
    classification_reason: base.classification_reason || "rules",
    extraction_source: base.extraction_source || "generic",
  };

  if (!llm) return out;

  // Classification: allow LLM to refine only when rule confidence was low,
  // or when base is still generic/general
  const ruleWeak =
    out.classification_confidence < 0.72 ||
    out.pageType === "generic" ||
    out.entity_type === "general";

  if (ruleWeak) {
    if (llm.pageType) out.pageType = llm.pageType;
    if (llm.entity_type) out.entity_type = llm.entity_type;
    out.classification_confidence = Math.max(
      out.classification_confidence,
      typeof llm.confidence === "number" ? llm.confidence : 0,
    );
    out.classification_reason = [
      out.classification_reason,
      llm.reason || "llm",
    ]
      .filter(Boolean)
      .join("+");
  }

  // entity_name: fill only if missing
  if (isEmpty(out.entity_name) && llm.entity_name) {
    out.entity_name = llm.entity_name;
  }

  // search_terms: merge, don't replace
  if (Array.isArray(llm.search_terms)) {
    const set = new Set(out.search_terms.map((t) => String(t).toLowerCase()));
    for (const t of llm.search_terms) {
      const key = String(t).toLowerCase().trim();
      if (key && !set.has(key)) {
        set.add(key);
        out.search_terms.push(key);
      }
    }
    out.search_terms = out.search_terms.slice(0, 40);
  }

  // attributes: LLM may ONLY fill missing keys — never overwrite deterministic commerce fields
  if (llm.attributes && typeof llm.attributes === "object") {
    for (const [key, value] of Object.entries(llm.attributes)) {
      if (isEmpty(value)) continue;
      if (DETERMINISTIC_ATTR_KEYS.has(key) && !isEmpty(out.attributes[key])) {
        continue; // deterministic wins
      }
      if (DETERMINISTIC_ATTR_KEYS.has(key) && isEmpty(out.attributes[key])) {
        // Allow fill only if value looks grounded (numbers for price, short strings for sku)
        if (key === "price" && typeof value !== "number") continue;
        if (
          (key === "original_price" ||
            key === "price_min" ||
            key === "price_max") &&
          typeof value !== "number"
        ) {
          continue;
        }
        if (key === "in_stock" && typeof value !== "boolean") continue;
        out.attributes[key] = value;
        continue;
      }
      if (isEmpty(out.attributes[key])) {
        out.attributes[key] = value;
      }
    }
  }

  return out;
}

module.exports = {
  applyValidation,
  DETERMINISTIC_ATTR_KEYS,
};
