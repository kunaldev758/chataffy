const LINK_STYLE =
  'color:#007bff; text-decoration:underline;';

const MAX_CONTACT_ITEMS = 8;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLink(url, label) {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label || url);
  return `<a href="${safeUrl}" target="_blank" style="${LINK_STYLE}">${safeLabel}</a>`;
}

function collectPayloadText(matches) {
  const parts = [];
  for (const match of matches || []) {
    const payload = match.payload || {};
    const url = payload.url || "";
    const title = payload.title || "";
    const text = payload.text || payload.pageContent || "";
    parts.push({ url, title, text: String(text) });
  }
  return parts;
}

const SOCIAL_PATTERNS = [
  { re: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi, label: "Facebook" },
  { re: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi, label: "Instagram" },
  { re: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^\s"'<>]+/gi, label: "Twitter/X" },
  { re: /https?:\/\/(?:www\.)?youtube\.com\/[^\s"'<>]+/gi, label: "YouTube" },
  { re: /https?:\/\/(?:www\.)?tiktok\.com\/[^\s"'<>]+/gi, label: "TikTok" },
  { re: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi, label: "LinkedIn" },
  { re: /https?:\/\/(?:www\.)?pinterest\.com\/[^\s"'<>]+/gi, label: "Pinterest" },
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const url = String(raw || "").replace(/[),.;]+$/g, "").trim();
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    out.push(url);
  }
  return out;
}

/**
 * Extract contact facts from retrieval matches (language-agnostic).
 * @returns {{ type: 'social'|'email'|'phone', key: string, label: string, value: string, url?: string }[]}
 */
function extractContactFacts(matches) {
  const facts = [];
  const seen = new Set();
  const payloads = collectPayloadText(matches);

  const addFact = (fact) => {
    if (!fact?.key || seen.has(fact.key) || facts.length >= MAX_CONTACT_ITEMS) {
      return false;
    }
    seen.add(fact.key);
    facts.push(fact);
    return facts.length >= MAX_CONTACT_ITEMS;
  };

  outer:
  for (const { text } of payloads) {
    for (const { re, label } of SOCIAL_PATTERNS) {
      const found = text.match(re) || [];
      for (const url of uniqueUrls(found)) {
        if (
          addFact({
            type: "social",
            key: `social:${url.toLowerCase()}`,
            label,
            value: url,
            url,
          })
        ) {
          break outer;
        }
      }
    }

    const emails = text.match(EMAIL_RE) || [];
    for (const email of emails) {
      if (email.length > 80) continue;
      if (
        addFact({
          type: "email",
          key: `email:${email.toLowerCase()}`,
          label: "Email",
          value: email,
        })
      ) {
        break outer;
      }
    }

    const phones = text.match(PHONE_RE) || [];
    for (const phone of phones) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      if (
        addFact({
          type: "phone",
          key: `phone:${digits}`,
          label: "Phone",
          value: phone.trim(),
        })
      ) {
        break outer;
      }
    }
  }

  return facts;
}

/**
 * @param {ReturnType<typeof extractContactFacts>} facts
 * @param {{ email?: string, phone?: string }} [fieldLabels]
 */
function buildContactListHtml(facts, fieldLabels = {}) {
  const emailLabel = fieldLabels.email || "Email";
  const phoneLabel = fieldLabels.phone || "Phone";

  const items = facts.map((fact) => {
    if (fact.type === "social") {
      return `<li>${escapeHtml(fact.label)}: ${formatLink(fact.url, fact.label)}</li>`;
    }
    if (fact.type === "email") {
      const safe = escapeHtml(fact.value);
      return `<li>${escapeHtml(emailLabel)}: <a href="mailto:${safe}">${safe}</a></li>`;
    }
    return `<li>${escapeHtml(phoneLabel)}: ${escapeHtml(fact.value)}</li>`;
  });

  return `<ul>${items.join("")}</ul>`;
}

function formatContactFromMatches(matches, options = {}) {
  const facts = extractContactFacts(matches);
  if (facts.length === 0) return null;

  const intro = options.intro || "Here is our contact information:";
  const listHtml = buildContactListHtml(facts, options.fieldLabels);
  return `<p>${escapeHtml(intro)}</p>${listHtml}`;
}

/**
 * Deterministic formatting before LLM — contact/social only.
 * Page links and product lists always use the LLM (relevance filtering required).
 */
function tryStructuredAnswer({ responseMode, matches }) {
  if (!matches?.length || responseMode !== "contact") return null;

  const answer = formatContactFromMatches(matches);
  if (!answer) return null;

  return { answer, source: "structured_contact" };
}

module.exports = {
  tryStructuredAnswer,
  formatContactFromMatches,
  extractContactFacts,
  buildContactListHtml,
};
