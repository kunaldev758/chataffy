/**
 * Lightweight unit checks for extract recovery helpers (no network / HTML fixtures).
 * Run: node services/contentPipeline/extractRecovery.test.js
 */
const assert = require("assert");
const {
  isExtractHealthy,
  isMateriallyBetter,
  scoreCandidate,
  reconcileTypeFromRecovery,
  wordCount,
} = require("./extractRecovery");

function testHealth() {
  const thin = isExtractHealthy(
    "- [Home](https://x.com/)\n- Vokkero\n\n# Vokkero",
    { htmlLength: 140000, title: "Vokkero Products - Sideline Power" },
  );
  assert.equal(thin.healthy, false, "breadcrumb shell should be unhealthy");

  const ok = isExtractHealthy(
    [
      "This is a real product listing with plenty of words about headsets,",
      "radios, batteries, and coaching accessories for sports teams that need",
      "reliable communication on the sideline during practices and games.",
      "Each kit includes chargers, spare mics, and weather-resistant cases",
      "so staff can stay connected across the full field without dropouts.",
    ].join(" "),
    { htmlLength: 1000, title: "Headsets" },
  );
  assert.equal(ok.healthy, true, "long prose should be healthy");
}

function testMateriallyBetter() {
  const baseline = {
    content: "- [Home](https://x.com/)\n- Vokkero\n\n# Vokkero",
    attributes: {},
  };
  const recovery = {
    content:
      "# Vokkero\n\n## Products\n- Headset A $100\n- Headset B $200\n- Radio Kit $300\nMore details about each coaching communication product for sideline use.",
    attributes: {
      product_count: 3,
      product_urls: ["https://x.com/a", "https://x.com/b", "https://x.com/c"],
    },
  };
  assert.equal(isMateriallyBetter(recovery, baseline), true);
  assert.equal(isMateriallyBetter(baseline, recovery), false);
}

function testReconcile() {
  const listing = reconcileTypeFromRecovery("listing", {
    pageType: "generic",
    entity_type: "category_list",
  });
  assert.equal(listing.pageType, "product");
  assert.equal(listing.entity_type, "listing");

  const product = reconcileTypeFromRecovery("product", {
    pageType: "blog",
    entity_type: "blog_post",
  });
  assert.equal(product.pageType, "product");
  assert.equal(product.entity_type, "product");
}

function testScore() {
  const weak = scoreCandidate({ content: "Home Vokkero", attributes: {} });
  const strong = scoreCandidate({
    content: "A ".repeat(80),
    attributes: { product_count: 5, product_urls: ["a", "b", "c", "d", "e"] },
  });
  assert.ok(strong > weak);
  assert.ok(wordCount("one two three") === 3);
}

testHealth();
testMateriallyBetter();
testReconcile();
testScore();
console.log("extractRecovery.test.js: all passed");
