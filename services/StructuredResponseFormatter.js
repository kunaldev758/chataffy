const LINK_STYLE =
  'color:#007bff; text-decoration:underline;';

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
 * Build contact/social HTML from retrieval matches when URLs or details are explicit.
 * Returns null when confidence is too low — caller should use LLM.
 */
function formatContactFromMatches(matches) {
  const items = [];
  const seen = new Set();
  const payloads = collectPayloadText(matches);

  const addItem = (key, html) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(html);
  };

  for (const { text } of payloads) {
    for (const { re, label } of SOCIAL_PATTERNS) {
      const found = text.match(re) || [];
      for (const url of uniqueUrls(found)) {
        addItem(`social:${url.toLowerCase()}`, `<li>${label}: ${formatLink(url, label)}</li>`);
      }
    }

    const emails = text.match(EMAIL_RE) || [];
    for (const email of emails) {
      if (email.length > 80) continue;
      addItem(`email:${email.toLowerCase()}`, `<li>Email: <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></li>`);
    }

    const phones = text.match(PHONE_RE) || [];
    for (const phone of phones) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      addItem(`phone:${digits}`, `<li>Phone: ${escapeHtml(phone.trim())}</li>`);
    }
  }

  if (items.length === 0) return null;

  return `<p>Here is our contact information:</p><ul>${items.join("")}</ul>`;
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
};
