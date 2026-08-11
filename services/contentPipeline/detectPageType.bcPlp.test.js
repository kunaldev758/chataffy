/**
 * PDP / PLP primary-region precedence tests.
 * Run: node services/contentPipeline/detectPageType.bcPlp.test.js
 */
const assert = require("assert");
const cheerio = require("cheerio");
const { detectPageType } = require("./detectPageType");

const bcCategoryHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Sideline Power Headsets Products - Sideline Power</title>
  <meta name="platform" content="bigcommerce.stencil" />
</head>
<body>
  <nav><a href="/">Home</a></nav>
  <h1>Sideline Power Headsets</h1>
  <div id="product-listing-container">
    <ul class="productGrid">
      <li class="product">
        <article class="card" data-product-id="207">
          <h4><a href="/sideline-power-elite-headset-double-muff/">Sideline Power Elite Headset Double Muff</a></h4>
          <span>Now: $150.00</span>
          <a href="/cart.php?action=add&product_id=207">Add to Cart</a>
        </article>
      </li>
      <li class="product">
        <article class="card" data-product-id="206">
          <h4><a href="/sideline-power-elite-headset-single-muff/">Sideline Power Elite Headset Single Muff</a></h4>
          <span>Now: $120.00</span>
          <a href="/cart.php?action=add&product_id=206">Add to Cart</a>
        </article>
      </li>
    </ul>
  </div>
</body>
</html>
`;

/** BC PDP with related product cards (must stay product, not listing). */
const bcPdpWithRelatedHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Sideline Power Elite Headset Double Muff</title>
</head>
<body>
  <div class="productView" data-entity="Product">
    <h1 class="productView-title">Sideline Power Elite Headset Double Muff</h1>
    <div class="productView-details">
      <div class="productView-price">$150.00</div>
      <form data-cart-item-add action="/cart.php">
        <input type="hidden" name="product_id" value="207" />
        <button type="submit">Add to Cart</button>
      </form>
      <p>Professional double muff headset for coaches.</p>
    </div>
  </div>
  <section class="productView-related" id="related-products">
    <h2>Related Products</h2>
    <ul class="productGrid">
      <li class="product">
        <article class="card" data-product-id="206">
          <a href="/sideline-power-elite-headset-single-muff/">Single Muff</a>
          <a href="/cart.php?action=add&product_id=206">Add to Cart</a>
        </article>
      </li>
      <li class="product">
        <article class="card" data-product-id="208">
          <a href="/other-headset/">Other Headset</a>
          <a href="/cart.php?action=add&product_id=208">Add to Cart</a>
        </article>
      </li>
      <li class="product">
        <article class="card" data-product-id="209">
          <a href="/battery-pack/">Battery Pack</a>
          <a href="/cart.php?action=add&product_id=209">Add to Cart</a>
        </article>
      </li>
    </ul>
  </section>
</body>
</html>
`;

const shopifyPdpWithRelatedHtml = `
<!DOCTYPE html>
<html>
<head><title>Lip Liner - Shop</title></head>
<body>
  <div class="product-form">
    <h1>After Hours Lip Liner</h1>
    <form class="product-form" action="/cart/add">
      <button type="submit">Add to cart</button>
    </form>
  </div>
  <div class="product-recommendations" data-product-recommendations>
    <div class="product-grid">
      <div class="product-card" data-product-id="1"><a href="/products/a">A</a> Add to cart</div>
      <div class="product-card" data-product-id="2"><a href="/products/b">B</a> Add to cart</div>
    </div>
  </div>
</body>
</html>
`;

const pureBlogHtml = `
<!DOCTYPE html>
<html>
<head><title>How Our Headsets Help Coaches</title></head>
<body>
  <article class="blog-post">
    <h1>How Our Headsets Help Coaches</h1>
    <div class="post-content">
      <p>Long form editorial about coaching communication without sell CTAs or product cards.</p>
      <p>More paragraphs of educational content for the blog section of the site.</p>
    </div>
  </article>
</body>
</html>
`;

function detect(url, title, html, schemaTypes = []) {
  const $ = cheerio.load(html);
  return detectPageType({
    url,
    schemaTypes,
    title,
    textSample: $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000),
    $,
  });
}

function testBcPlp() {
  const result = detect(
    "https://sidelinepower.com/sideline-power-headsets/",
    "Sideline Power Headsets Products - Sideline Power",
    bcCategoryHtml,
  );
  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "listing");
  assert.ok(
    /primary_listing|title:products|commerce/i.test(result.reason),
    `unexpected reason: ${result.reason}`,
  );
  console.log("BC PLP OK", {
    entity_type: result.entity_type,
    reason: result.reason,
  });
}

function testBcPdpWithRelated() {
  const result = detect(
    "https://sidelinepower.com/sideline-power-elite-headset-double-muff/",
    "Sideline Power Elite Headset Double Muff",
    bcPdpWithRelatedHtml,
  );
  assert.equal(result.pageType, "product", result.reason);
  assert.equal(
    result.entity_type,
    "product",
    `PDP must not flip to listing: ${result.reason}`,
  );
  assert.ok(
    /primary_pdp|force_product/i.test(result.reason),
    `expected primary PDP reason, got ${result.reason}`,
  );
  assert.ok(
    !/prefer_listing_over_pdp/i.test(result.reason),
    "prefer_listing_over_pdp must not run",
  );
  console.log("BC PDP+related OK", {
    entity_type: result.entity_type,
    reason: result.reason,
  });
}

function testShopifyPdpRelated() {
  const result = detect(
    "https://shop.example.com/products/after-hours-lip-liner",
    "After Hours Lip Liner",
    shopifyPdpWithRelatedHtml,
  );
  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "product", result.reason);
  console.log("Shopify PDP+related OK", {
    entity_type: result.entity_type,
    reason: result.reason,
  });
}

function testShopifyCollection() {
  const html = `
  <html><head><title>All Products</title></head>
  <body>
    <div id="ProductGridContainer">
      <div id="product-grid" class="product-grid">
        <div class="product-card" data-product-id="1">A</div>
        <div class="product-card" data-product-id="2">B</div>
      </div>
    </div>
  </body></html>`;
  const result = detect(
    "https://shop.example.com/collections/all",
    "All Products",
    html,
  );
  assert.equal(result.pageType, "product");
  assert.equal(result.entity_type, "listing", result.reason);
  console.log("Shopify collection OK", { reason: result.reason });
}

function testArticleOnlyStillBlog() {
  const result = detect(
    "https://sidelinepower.com/blog/how-headsets-help",
    "How Our Headsets Help Coaches",
    pureBlogHtml,
  );
  assert.equal(result.pageType, "blog");
  assert.equal(result.entity_type, "blog_post");
  console.log("Pure blog OK");
}

function testPricingStillGeneric() {
  const html = `
    <html><head><title>Pricing</title>
    <script type="application/ld+json">{"@type":"FAQPage"}</script>
    </head>
    <body><main><h1>One Plan</h1>
    <section class="faq-section"><h2>FAQ</h2></section>
    </main></body></html>`;
  const result = detect("https://example.com/pricing", "Pricing", html, [
    "FAQPage",
  ]);
  assert.equal(result.pageType, "generic");
  assert.equal(result.deterministic, true);
  console.log("Pricing OK");
}

testBcPlp();
testBcPdpWithRelated();
testShopifyPdpRelated();
testShopifyCollection();
testArticleOnlyStillBlog();
testPricingStillGeneric();
console.log("detectPageType.bcPlp.test.js: all passed");
