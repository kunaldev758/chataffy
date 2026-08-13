const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const { detectPageType } = require("./detectPageType");
const {
  extractByPageType,
  resolveProductEntityType,
  isListingPathUrl,
} = require("./extractByPageType");
const { extractListingFromJsonLd } = require("./extractors/listing");
const { extractPriceFromOffer } = require("./extractors/product");

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

/** BigCommerce PDP: Product schema + related product cards, flat URL. */
const berryKingStylePdpHtml = `
<!doctype html>
<html>
  <head>
    <title>Brightwell Rabbiteye Blueberry Plant - Shop Now</title>
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org/",
        "@type": "Product",
        name: "Brightwell Rabbiteye Blueberry Plant",
        url: "https://berryking.com/brightwell-rabbiteye-blueberry-plant/",
        offers: {
          "@type": "Offer",
          priceCurrency: "USD",
          minPrice: "22.49",
          maxPrice: "39.99",
        },
      })}
    </script>
  </head>
  <body>
    <h1>Brightwell Rabbiteye Blueberry Plant</h1>
    <form class="product-form" data-product-id="119">
      <span class="price">Now: $22.49 - $39.99</span>
      <button>Add to Cart</button>
    </form>
    <div class="productView-related">
      <article class="card product"><a href="/alapaha/">Alapaha</a><span class="price">$29.99</span></article>
      <article class="card product"><a href="/prince/">Prince</a><span class="price">$29.99</span></article>
      <article class="card product"><a href="/premier/">Premier</a><span class="price">$29.99</span></article>
      <article class="card product"><a href="/austin/">Austin</a><span class="price">$29.99</span></article>
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

test("schema Product + related cards on flat URL is ambiguous (use LLM), not force listing", () => {
  const url = "https://berryking.com/brightwell-rabbiteye-blueberry-plant";
  const $ = cheerio.load(berryKingStylePdpHtml);
  const rules = detectPageType({
    url,
    schemaTypes: ["Product", "Offer", "Brand"],
    title: "Brightwell Rabbiteye Blueberry Plant - Shop Now",
    textSample: $("body").text(),
    $,
  });
  const resolved = resolveProductEntityType(rules, url, $, [
    "Product",
    "Offer",
    "Brand",
  ]);

  assert.equal(resolved.pageType, "product");
  assert.equal(resolved.entity_type, "product");
  assert.equal(resolved.needsLlm, true);
  assert.equal(resolved.deterministic, false);
  assert.match(String(resolved.reason), /pdp_plp_ambiguous_use_llm/);
  assert.equal(isListingPathUrl(url), false);
});

test("extractByPageType keeps product branch for BerryKing-style PDP when LLM skipped", async () => {
  const url = "https://berryking.com/brightwell-rabbiteye-blueberry-plant";
  const prev = process.env.PAGE_TYPE_LLM_ENABLED;
  process.env.PAGE_TYPE_LLM_ENABLED = "false";
  try {
    const result = await extractByPageType(url, berryKingStylePdpHtml, {});
    assert.equal(result.pageType, "product");
    assert.equal(result.entity_type, "product");
    assert.match(String(result.classification_reason || ""), /ambiguous_use_llm/);
    assert.match(result.content, /22\.49|Price/i);
  } finally {
    if (prev == null) delete process.env.PAGE_TYPE_LLM_ENABLED;
    else process.env.PAGE_TYPE_LLM_ENABLED = prev;
  }
});

test("extractPriceFromOffer and listing LD read BigCommerce minPrice/maxPrice", () => {
  const fromOffer = extractPriceFromOffer({
    minPrice: "22.49",
    maxPrice: "39.99",
    priceCurrency: "USD",
  });
  assert.equal(fromOffer.price_min, 22.49);
  assert.equal(fromOffer.price_max, 39.99);
  assert.equal(fromOffer.price, 22.49);

  const products = extractListingFromJsonLd(
    [
      {
        "@type": "Product",
        name: "Brightwell",
        url: "https://berryking.com/brightwell/",
        offers: { minPrice: "22.49", maxPrice: "39.99", priceCurrency: "USD" },
      },
      {
        "@type": "Product",
        name: "Brightwell",
        url: "https://berryking.com/brightwell/",
        offers: { price: "22.49", priceCurrency: "USD" },
      },
    ],
    "https://berryking.com/brightwell/",
  );
  assert.equal(products.length, 1);
  assert.equal(products[0].price_min, 22.49);
  assert.equal(products[0].price_max, 39.99);
  assert.equal(products[0].price, 22.49);
});
