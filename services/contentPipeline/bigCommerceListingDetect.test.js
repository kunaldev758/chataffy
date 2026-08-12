const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const { detectPageType } = require("./detectPageType");
const { extractByPageType } = require("./extractByPageType");

/** Minimal BigCommerce-style brand/category PLP (custom slug, no /collections/). */
const bigCommerceListingHtml = `
<!doctype html>
<html>
  <head>
    <title>Sideline Power Headsets</title>
  </head>
  <body>
    <h1>Sideline Power Headsets</h1>
    <div id="product-listing-container">
      <ul class="productGrid">
        <li class="product">
          <article class="card">
            <h4><a href="/sideline-power-elite-headset-double-muff/">Sideline Power Elite Headset Double Muff</a></h4>
            <span class="price">Now: $150.00</span>
            <a href="/cart.php?action=add&product_id=207">Add to Cart</a>
          </article>
        </li>
        <li class="product">
          <article class="card">
            <h4><a href="/sideline-power-elite-headset-single-muff/">Sideline Power Elite Headset Single Muff</a></h4>
            <span class="price">Now: $120.00</span>
            <a href="/cart.php?action=add&product_id=206">Add to Cart</a>
          </article>
        </li>
      </ul>
    </div>
  </body>
</html>`;

test("custom BigCommerce PLP URL classifies as product+listing via DOM grid", () => {
  const url = "https://sidelinepower.com/sideline-power-headsets";
  const $ = cheerio.load(bigCommerceListingHtml);
  const result = detectPageType({
    url,
    schemaTypes: [],
    title: "Sideline Power Headsets",
    textSample: $("body").text(),
    $,
  });

  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "listing");
  assert.equal(result.needsLlm, false);
  assert.match(String(result.reason), /dom:product_grid|dom:product_cards/);
});

test("extractByPageType uses listing branch for BigCommerce custom PLP", async () => {
  const url = "https://sidelinepower.com/sideline-power-headsets";
  const result = await extractByPageType(url, bigCommerceListingHtml, {});

  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "listing");
  assert.match(String(result.extraction_source || ""), /listing/i);
  assert.match(result.content, /Double Muff/i);
  assert.match(result.content, /Single Muff/i);
  assert.ok(
    String(result.content).split(/\s+/).filter(Boolean).length >= 30,
    "listing extract should clear the 30-word quality gate",
  );
});

test("Shopify-style PDP URL still prefers product over related cards", () => {
  const html = `
<!doctype html>
<html><body>
  <form class="product-form" data-product-id="1">
    <h1>Elite Headset</h1>
    <button>Add to Cart</button>
  </form>
  <div class="related">
    <div class="product-card">Related A</div>
    <div class="product-card">Related B</div>
  </div>
</body></html>`;
  const url = "https://example.com/products/elite-headset";
  const $ = cheerio.load(html);
  const result = detectPageType({
    url,
    schemaTypes: ["Product"],
    title: "Elite Headset",
    textSample: $("body").text(),
    $,
  });

  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "product");
});
