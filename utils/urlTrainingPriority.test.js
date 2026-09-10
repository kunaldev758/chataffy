const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scoreUrlForTraining,
  sortUrlsForTraining,
} = require("./urlTrainingPriority");

test("homepage ranks above products and blogs", () => {
  assert.ok(
    scoreUrlForTraining("https://store.com/") >
      scoreUrlForTraining("https://store.com/products/blue-shirt"),
  );
  assert.ok(
    scoreUrlForTraining("https://store.com/faq") >
      scoreUrlForTraining("https://store.com/collections/shoes"),
  );
  assert.ok(
    scoreUrlForTraining("https://store.com/shipping") >
      scoreUrlForTraining("https://store.com/blog/news"),
  );
});

test("sortUrlsForTraining puts support pages first", () => {
  const sorted = sortUrlsForTraining([
    "https://shop.com/products/sku-999",
    "https://shop.com/blog/hello",
    "https://shop.com/faq",
    "https://shop.com/",
    "https://shop.com/collections/hats",
  ]);

  assert.equal(sorted[0], "https://shop.com/");
  assert.equal(sorted[1], "https://shop.com/faq");
  assert.ok(sorted.indexOf("https://shop.com/collections/hats") < sorted.indexOf("https://shop.com/products/sku-999"));
});

test("tag/author URLs score as low value", () => {
  assert.ok(
    scoreUrlForTraining("https://shop.com/tagged/sale") <
      scoreUrlForTraining("https://shop.com/products/item"),
  );
});

const {
  isNonContentPath,
  filterAndDedupeWebUrls,
} = require("./webUrlUtils");

test("isNonContentPath skips tags, authors, and paginated paths", () => {
  assert.equal(isNonContentPath("https://shop.com/tagged/sale"), true);
  assert.equal(isNonContentPath("https://shop.com/author/jane"), true);
  assert.equal(isNonContentPath("https://shop.com/blog/page/2"), true);
  assert.equal(isNonContentPath("https://shop.com/faq"), false);
});

test("filterAndDedupeWebUrls drops tag URLs from training queues", () => {
  const kept = filterAndDedupeWebUrls([
    "https://shop.com/faq",
    "https://shop.com/tagged/sale",
    "https://shop.com/products/shirt",
  ]);
  assert.deepEqual(kept, [
    "https://shop.com/faq",
    "https://shop.com/products/shirt",
  ]);
});
