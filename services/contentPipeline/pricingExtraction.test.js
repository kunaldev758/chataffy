const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const { detectPageType } = require("./detectPageType");
const { extractGenericMarkdown } = require("./extractGenericMarkdown");
const { extractByPageType } = require("./extractByPageType");

const pricingHtml = `
<!doctype html>
<html>
  <head>
    <title>Forever Free Support Platform</title>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [{
          "@type": "Question",
          "name": "Can I use it for free?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, the platform is free forever."
          }
        }]
      }
    </script>
  </head>
  <body>
    <main>
      <h1>One Plan, Zero Cost</h1>
      <h2>$0/mo</h2>
      <div class="pricing-features">
        <span>50 Monthly Chats</span>
        <span>2 Human Agents</span>
        <span>10 MB Database Storage</span>
      </div>
      <section class="faq-section">
        <h2>Frequently Asked Questions</h2>
        <button class="accordionBtn">Can I use it for free?</button>
        <div>Yes, the platform is free forever.</div>
      </section>
    </main>
  </body>
</html>`;

test("pricing URL wins over embedded FAQ signals", () => {
  const $ = cheerio.load(pricingHtml);
  const result = detectPageType({
    url: "https://example.com/pricing",
    schemaTypes: ["FAQPage", "Question"],
    title: "Forever Free Support Platform",
    textSample: $("body").text(),
    $,
  });

  assert.equal(result.pageType, "generic");
  assert.equal(result.entity_type, "general");
  assert.equal(result.deterministic, true);
  assert.equal(result.needsLlm, false);
});

test("generic extraction preserves pricing features and FAQ button labels", () => {
  const result = extractGenericMarkdown(
    "https://example.com/pricing",
    pricingHtml,
    {},
  );

  assert.match(result.content, /\$0\/mo/);
  assert.match(result.content, /50 Monthly Chats/);
  assert.match(result.content, /2 Human Agents/);
  assert.match(result.content, /10 MB Database Storage/);
  assert.match(result.content, /### Can I use it for free\?/);
});

test("pricing pipeline keeps plan content when FAQ schema is present", async () => {
  const result = await extractByPageType(
    "https://example.com/pricing",
    pricingHtml,
    {},
  );

  assert.equal(result.pageType, "generic");
  assert.match(result.content, /\$0\/mo/);
  assert.match(result.content, /50 Monthly Chats/);
  assert.match(result.content, /Can I use it for free\?/);
});
