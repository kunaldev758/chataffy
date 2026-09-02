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

const enoughWords =
  "Search engine marketing is paid advertising that puts ads in search results. " +
  "Businesses bid on keywords so their offers show above organic listings. " +
  "This article explains how SEM campaigns work and when to use them.";

test("blog slug containing search-engine is not treated as a search utility URL", () => {
  const wordCount = enoughWords.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount >= DEFAULT_MIN_WORDS);

  const result = checkQualityGates(
    {
      rawText: enoughWords,
      pageTitle: "Search Engine Marketing (SEM) Explained",
      url: "https://example.com/blog/search-engine-marketing-explained",
      metrics: { wordCount },
    },
    { mode: "strict" },
  );

  assert.equal(result.pass, true);
});

test("actual /search utility URLs are still excluded", () => {
  const wordCount = enoughWords.split(/\s+/).filter(Boolean).length;
  const urls = [
    "https://example.com/search",
    "https://example.com/search/",
    "https://example.com/search?q=printers",
  ];

  for (const url of urls) {
    const result = checkQualityGates(
      {
        rawText: enoughWords,
        pageTitle: "Search",
        url,
        metrics: { wordCount },
      },
      { mode: "strict" },
    );

    assert.equal(result.pass, false, url);
    assert.match(result.reason, /Excluded utility or sitemap URL pattern/);
  }
});

test("hyphenated content slugs are not treated as utility path segments", () => {
  const wordCount = enoughWords.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount >= DEFAULT_MIN_WORDS);

  const urls = [
    "https://example.com/order-fulfillment",
    "https://example.com/blog/order-processing",
    "https://example.com/services/order-fulfilment-software",
    "https://example.com/search-engine-marketing",
    "https://example.com/account-management",
    "https://example.com/cart-abandonment-guide",
  ];

  for (const url of urls) {
    const result = checkQualityGates(
      {
        rawText: enoughWords,
        pageTitle: "Content page",
        url,
        metrics: { wordCount },
      },
      { mode: "strict" },
    );

    assert.equal(result.pass, true, url);
  }
});

test("exact utility path segments are still excluded on any host", () => {
  const wordCount = enoughWords.split(/\s+/).filter(Boolean).length;
  const urls = [
    "https://example.com/order",
    "https://example.com/orders",
    "https://shop.example.com/order/",
    "https://example.com/en/orders/123",
    "https://example.com/order?id=123",
    "https://example.com/search",
    "https://example.com/cart",
    "https://example.com/sitemap.xml",
  ];

  for (const url of urls) {
    const result = checkQualityGates(
      {
        rawText: enoughWords,
        pageTitle: "Utility",
        url,
        metrics: { wordCount },
      },
      { mode: "strict" },
    );

    assert.equal(result.pass, false, url);
    assert.match(result.reason, /Excluded utility or sitemap URL pattern/);
  }
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
