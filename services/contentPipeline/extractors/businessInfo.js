/**
 * JSON-LD → prose extraction for LocalBusiness / Organization style schema.
 *
 * Product, Listing and FAQ JSON-LD are already handled by their dedicated
 * extractors. This module fills the remaining gap: business identity/contact
 * schema (name, phone, email, address, opening hours, price range) commonly
 * present on About/Contact/homepage markup but never surfaced as indexable
 * text — it's currently only consumed for page-type classification.
 */

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function walkJsonLd(nodes, visit) {
  const seen = new WeakSet();
  const visitNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    visit(node);
    if (Array.isArray(node)) {
      for (const item of node) visitNode(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "@context") continue;
      if (value && typeof value === "object") visitNode(value);
    }
  };
  for (const node of asArray(nodes)) visitNode(node);
}

function typeList(node) {
  return asArray(node["@type"]).map((t) =>
    String(t || "")
      .toLowerCase()
      .replace(/^https?:\/\/schema\.org\//, "")
      .replace(/^schema\.org\//, "")
      .trim(),
  );
}

const BUSINESS_TYPE_KEYS = new Set([
  "localbusiness",
  "organization",
  "store",
  "restaurant",
  "hotel",
  "medicalbusiness",
  "corporation",
  "ngo",
  "professionalservice",
]);

function formatAddress(address) {
  if (!address) return null;
  if (typeof address === "string") return address.trim() || null;
  if (typeof address === "object") {
    const parts = [
      address.streetAddress,
      address.addressLocality,
      address.addressRegion,
      address.postalCode,
      address.addressCountry,
    ]
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

function formatOpeningHours(node) {
  if (node.openingHours) {
    return Array.isArray(node.openingHours)
      ? node.openingHours.join(", ")
      : String(node.openingHours);
  }
  if (node.openingHoursSpecification) {
    const specs = asArray(node.openingHoursSpecification);
    const formatted = specs
      .map((s) => {
        if (!s || typeof s !== "object") return "";
        const days = Array.isArray(s.dayOfWeek)
          ? s.dayOfWeek.map((d) => String(d).replace(/^https?:\/\/schema\.org\//, "")).join("-")
          : s.dayOfWeek
            ? String(s.dayOfWeek).replace(/^https?:\/\/schema\.org\//, "")
            : "";
        if (!days && !s.opens && !s.closes) return "";
        return `${days}: ${s.opens || ""}-${s.closes || ""}`.trim();
      })
      .filter(Boolean)
      .join(", ");
    return formatted || null;
  }
  return null;
}

/**
 * Walk JSON-LD blocks and merge LocalBusiness/Organization-style fields into
 * one best-effort business profile (multiple nodes on a page, e.g. Website +
 * Organization, are merged by filling missing keys only).
 *
 * @param {object[]} jsonLdBlocks - raw parsed JSON-LD documents (as collected by extractPageMetadata)
 * @returns {{ content: string, attributes: object, confidence: number, source: string } | null}
 */
function extractBusinessInfoFromJsonLd(jsonLdBlocks = []) {
  let merged = null;

  walkJsonLd(jsonLdBlocks, (node) => {
    const types = typeList(node);
    if (!types.some((t) => BUSINESS_TYPE_KEYS.has(t))) return;

    const fields = {
      name: node.name || null,
      telephone: node.telephone || null,
      email: node.email || null,
      website: node.url || null,
      address: formatAddress(node.address),
      openingHours: formatOpeningHours(node),
      priceRange: node.priceRange || null,
      description:
        typeof node.description === "string" ? node.description.trim() : null,
    };

    for (const k of Object.keys(fields)) {
      if (!fields[k]) delete fields[k];
    }
    if (Object.keys(fields).length === 0) return;

    if (!merged) {
      merged = fields;
      return;
    }
    for (const [k, v] of Object.entries(fields)) {
      if (merged[k] == null) merged[k] = v;
    }
  });

  if (!merged) return null;

  const lines = ["## Business Information"];
  if (merged.name) lines.push(`- Name: ${merged.name}`);
  if (merged.telephone) lines.push(`- Phone: ${merged.telephone}`);
  if (merged.email) lines.push(`- Email: ${merged.email}`);
  if (merged.website) lines.push(`- Website: ${merged.website}`);
  if (merged.address) lines.push(`- Address: ${merged.address}`);
  if (merged.openingHours) lines.push(`- Opening Hours: ${merged.openingHours}`);
  if (merged.priceRange) lines.push(`- Price Range: ${merged.priceRange}`);
  if (merged.description) lines.push(`- Description: ${merged.description}`);

  if (lines.length <= 1) return null;

  return {
    content: lines.join("\n"),
    attributes: {
      phone: merged.telephone || null,
      email: merged.email || null,
      address: merged.address || null,
    },
    confidence: 0.85,
    source: "json_ld_business",
  };
}

module.exports = {
  extractBusinessInfoFromJsonLd,
};
