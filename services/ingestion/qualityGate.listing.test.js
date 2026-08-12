const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkQualityGates,
  resolveMinWordCount,
  STRUCTURED_LISTING_MIN_WORDS,
  DEFAULT_MIN_WORDS,
} = require("./qualityGate");

const thinListingMarkdown = `# Procom Products - Sideline Power

Collection URL:
https://sidelinepower.com/procom

## Product

Name:
Procom X12 5 Coach System

Price:
$1950

Category:
Procom- Sideline Power

Availability:
In Stock

Product URL:
https://sidelinepower.com/procom-x12-5-coach-system/`;

test("structured listing uses lower word minimum", () => {
  const wordCount = thinListingMarkdown.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount < DEFAULT_MIN_WORDS, "fixture should be under default 30");
  assert.ok(wordCount >= STRUCTURED_LISTING_MIN_WORDS);

  const min = resolveMinWordCount(
    { rawText: thinListingMarkdown },
    { preferPageType: "product", preferEntityType: "listing" },
  );
  assert.equal(min, STRUCTURED_LISTING_MIN_WORDS);
});

test("thin structured listing passes quality gate with preferEntityType=listing", () => {
  const wordCount = thinListingMarkdown.split(/\s+/).filter(Boolean).length;
  const result = checkQualityGates(
    {
      rawText: thinListingMarkdown,
      pageTitle: "Procom Products - Sideline Power",
      url: "https://sidelinepower.com/procom",
      metrics: { wordCount },
    },
    {
      mode: "strict",
      preferPageType: "product",
      preferEntityType: "listing",
    },
  );

  assert.equal(result.pass, true);
  assert.equal(result.minWords, STRUCTURED_LISTING_MIN_WORDS);
});

test("short non-listing page still fails at 30 words", () => {
  const text = "About us we sell things and do stuff here today yes.";
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount < 30);

  const result = checkQualityGates(
    {
      rawText: text,
      pageTitle: "About",
      url: "https://example.com/about",
      metrics: { wordCount },
    },
    { mode: "strict" },
  );

  assert.equal(result.pass, false);
  assert.match(result.reason, /< 30 threshold/);
});
