const cheerio = require("cheerio");

const CLOUDFLARE_EMAIL_PATH_RE =
  /\/cdn-cgi\/l\/email-protection(?:#|%23)([0-9a-f]+)/i;

/**
 * Decode Cloudflare's XOR-based data-cfemail value.
 * Returns null for malformed values or decoded text that is not an email.
 */
function decodeCloudflareEmail(encoded) {
  const hex = String(encoded || "").trim();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }

  const key = Number.parseInt(hex.slice(0, 2), 16);
  const bytes = [];
  for (let index = 2; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16) ^ key);
  }

  const email = Buffer.from(bytes).toString("utf8").trim();
  if (
    !email ||
    /[\u0000-\u001f\u007f]/.test(email) ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(email)
  ) {
    return null;
  }

  return email;
}

function removeCloudflareClass($, el) {
  const classes = String($(el).attr("class") || "")
    .split(/\s+/)
    .filter((name) => name && name !== "__cf_email__");

  if (classes.length > 0) {
    $(el).attr("class", classes.join(" "));
  } else {
    $(el).removeAttr("class");
  }
}

/**
 * Decode Cloudflare-protected email elements in an existing Cheerio document.
 * Mutates the document and returns the number of successfully decoded emails.
 */
function decodeCloudflareEmails($) {
  if (typeof $ !== "function") return 0;

  let decodedCount = 0;
  $("[data-cfemail], a[href*='/cdn-cgi/l/email-protection']").each((_, el) => {
    const href = String($(el).attr("href") || "");
    const hrefMatch = href.match(CLOUDFLARE_EMAIL_PATH_RE);
    const encoded = $(el).attr("data-cfemail") || hrefMatch?.[1] || "";
    const email = decodeCloudflareEmail(encoded);
    if (!email) return;

    $(el).text(email).removeAttr("data-cfemail");
    removeCloudflareClass($, el);
    if (String(el.tagName || "").toLowerCase() === "a") {
      $(el).attr("href", `mailto:${email}`);
    }
    decodedCount += 1;
  });

  return decodedCount;
}

/** Decode protected emails in a complete HTML string. */
function decodeCloudflareEmailsInHtml(html) {
  if (!html || typeof html !== "string") return html;

  const $ = cheerio.load(html);
  if (decodeCloudflareEmails($) === 0) return html;
  return $.html();
}

module.exports = {
  decodeCloudflareEmail,
  decodeCloudflareEmails,
  decodeCloudflareEmailsInHtml,
};
