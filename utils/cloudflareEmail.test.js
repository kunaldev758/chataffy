const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const {
  decodeCloudflareEmail,
  decodeCloudflareEmails,
  decodeCloudflareEmailsInHtml,
} = require("./cloudflareEmail");
const {
  extractGenericMarkdown,
} = require("../services/contentPipeline/extractGenericMarkdown");
const {
  normalizePage,
} = require("../services/ingestion/normalizer");

function encodeCloudflareEmail(email, key = 0x42) {
  const encoded = [key, ...Buffer.from(email, "utf8").map((byte) => byte ^ key)];
  return Buffer.from(encoded).toString("hex");
}

test("decodes a valid Cloudflare email value", () => {
  const encoded = encodeCloudflareEmail("support@example.com");
  assert.equal(decodeCloudflareEmail(encoded), "support@example.com");
});

test("rejects malformed and non-email decoded values", () => {
  assert.equal(decodeCloudflareEmail("not-hex"), null);
  assert.equal(decodeCloudflareEmail(encodeCloudflareEmail("not an email")), null);
});

test("rewrites protected anchors as normal mailto links", () => {
  const encoded = encodeCloudflareEmail("hello@example.com");
  const $ = cheerio.load(
    `<a class="contact __cf_email__" href="/cdn-cgi/l/email-protection" data-cfemail="${encoded}">[email protected]</a>`,
  );

  assert.equal(decodeCloudflareEmails($), 1);
  assert.equal($("a").text(), "hello@example.com");
  assert.equal($("a").attr("href"), "mailto:hello@example.com");
  assert.equal($("a").attr("class"), "contact");
  assert.equal($("a").attr("data-cfemail"), undefined);
});

test("decodes href-fragment protection without data-cfemail", () => {
  const encoded = encodeCloudflareEmail("sales@example.com");
  const decodedHtml = decodeCloudflareEmailsInHtml(
    `<a href="/cdn-cgi/l/email-protection#${encoded}">Email us</a>`,
  );
  const $ = cheerio.load(decodedHtml);

  assert.equal($("a").text(), "sales@example.com");
  assert.equal($("a").attr("href"), "mailto:sales@example.com");
});

test("generic homepage extraction indexes a decoded footer email", () => {
  const encoded = encodeCloudflareEmail("support@example.com");
  const result = extractGenericMarkdown(
    "https://example.com/",
    `<html><body><main>Welcome to Example</main><footer><a class="__cf_email__" data-cfemail="${encoded}" href="/cdn-cgi/l/email-protection">[email protected]</a></footer></body></html>`,
    {},
  );

  assert.match(result.content, /Email: support@example\.com/);
  assert.doesNotMatch(result.content, /\[email protected\]/);
});

test("HTML normalization extracts and indexes a decoded body email", () => {
  const encoded = encodeCloudflareEmail("help@example.com");
  const result = normalizePage(
    `<html><body><main>Contact <a data-cfemail="${encoded}" href="/cdn-cgi/l/email-protection">[email protected]</a></main></body></html>`,
    "https://example.com/contact",
  );

  assert.deepEqual(result.contactInfo.emails, ["help@example.com"]);
  assert.match(result.rawText, /help@example\.com/);
  assert.doesNotMatch(result.rawText, /\[email protected\]/);
});
