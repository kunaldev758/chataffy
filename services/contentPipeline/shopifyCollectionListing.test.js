const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const {
  extractListingContent,
  mapShopifyCollectionProduct,
  shopifyCollectionPath,
  isJunkListingName,
  isRichShopifyCollectionProducts,
} = require("./extractors/listing");

test("isJunkListingName rejects swatch and chrome labels", () => {
  assert.equal(isJunkListingName("+"), true);
  assert.equal(isJunkListingName("Show more"), true);
  assert.equal(isJunkListingName("+ Show more"), true);
  assert.equal(isJunkListingName("Add to cart"), true);
  assert.equal(
    isJunkListingName("Men's Daily Wear PU Sandals - Style 6004"),
    false,
  );
});

test("shopifyCollectionPath only matches collection PLP URLs", () => {
  assert.deepEqual(
    shopifyCollectionPath("https://jogger.co.in/collections/new-arrivals"),
    { origin: "https://jogger.co.in", handle: "new-arrivals" },
  );
  assert.deepEqual(
    shopifyCollectionPath("https://jogger.co.in/collections/new-arrivals/"),
    { origin: "https://jogger.co.in", handle: "new-arrivals" },
  );
  assert.equal(
    shopifyCollectionPath(
      "https://jogger.co.in/collections/new-arrivals/products/eva-clogs",
    ),
    null,
  );
  assert.equal(
    shopifyCollectionPath("https://sidelinepower.com/sideline-power-headsets"),
    null,
  );
});

test("mapShopifyCollectionProduct keeps major-unit prices (not cents)", () => {
  const row = mapShopifyCollectionProduct(
    {
      title: "Men's Daily Wear PU Sandals - Style 6004",
      handle: "mens-daily-wear-pu-sandals-style-6004",
      vendor: "Jogger",
      variants: [
        { price: "689.00", available: true },
        { price: "689.00", available: true },
      ],
    },
    "https://jogger.co.in",
  );
  assert.equal(row.name, "Men's Daily Wear PU Sandals - Style 6004");
  assert.equal(row.price, 689);
  assert.equal(
    row.url,
    "https://jogger.co.in/products/mens-daily-wear-pu-sandals-style-6004",
  );
  assert.equal(row.brand, "Jogger");
  assert.doesNotMatch(String(row.price), /^6\.89$/);
});

test("extractListingContent prefers Shopify collection products.json", async () => {
  const orig = axios.get;
  axios.get = async (endpoint) => {
    assert.match(String(endpoint), /\/collections\/new-arrivals\/products\.json/);
    return {
      data: JSON.stringify({
        products: [
          {
            title: "Men's Daily Wear PU Sandals - Style 6004",
            handle: "mens-daily-wear-pu-sandals-style-6004",
            vendor: "Jogger",
            variants: [{ price: "689.00", available: true }],
          },
          {
            title: "Super Soft PU Sandals for Men - Style 5403",
            handle: "super-soft-pu-sandals-for-men-style-5403",
            vendor: "Jogger",
            variants: [{ price: "949.00", available: true }],
          },
        ],
      }),
    };
  };
  try {
    const result = await extractListingContent({
      url: "https://jogger.co.in/collections/new-arrivals",
      html: `
        <html><body>
          <div class="cart-drawer">Your cart is empty</div>
          <div class="product-card"><a href="/products/x">+</a></div>
          <span>₹689.00</span>
        </body></html>
      `,
      title: "New Arrivals – Jogger Footwear",
      metaDescription: "Shop new arrival footwear online",
    });
    assert.match(String(result.extraction_source), /shopify_collection_json/);
    assert.ok(result.products.length >= 2);
    assert.equal(result.products[0].price, 689);
    assert.equal(result.products[1].price, 949);
    assert.match(result.content, /Style 6004/);
    assert.match(result.content, /689/);
    assert.doesNotMatch(result.content, /\nName:\n\+\n/);
    assert.ok(isRichShopifyCollectionProducts(result.products));
  } finally {
    axios.get = orig;
  }
});

test("extractListingContent keeps BigCommerce DOM path when not a /collections/ URL", async () => {
  const orig = axios.get;
  let called = false;
  axios.get = async () => {
    called = true;
    throw new Error("should not fetch collection products.json");
  };
  try {
    const html = `
<!doctype html>
<html>
  <body>
    <div id="product-listing-container">
      <ul class="productGrid">
        <li class="product">
          <article class="card">
            <h4><a href="/sideline-power-elite-headset-double-muff/">Sideline Power Elite Headset Double Muff</a></h4>
            <span class="price">Now: $150.00</span>
          </article>
        </li>
        <li class="product">
          <article class="card">
            <h4><a href="/sideline-power-elite-headset-single-muff/">Sideline Power Elite Headset Single Muff</a></h4>
            <span class="price">Now: $120.00</span>
          </article>
        </li>
      </ul>
    </div>
  </body>
</html>`;
    const result = await extractListingContent({
      url: "https://sidelinepower.com/sideline-power-headsets",
      html,
      title: "Sideline Power Headsets",
    });
    assert.equal(called, false);
    assert.match(String(result.extraction_source), /dom_listing/);
    assert.match(result.content, /Double Muff/i);
    assert.match(result.content, /150/);
  } finally {
    axios.get = orig;
  }
});

test("extractListingContent falls back to DOM when products.json fails", async () => {
  const orig = axios.get;
  axios.get = async () => {
    const err = new Error("Not Found");
    err.response = { status: 404 };
    throw err;
  };
  try {
    const html = `
<!doctype html>
<html><body>
  <div id="product-grid" class="product-grid">
    <div class="product-card" data-product-handle="sandal-a">
      <a href="/products/sandal-a"><h3 class="card__heading">Sandal A</h3></a>
      <span class="price">₹499.00</span>
    </div>
    <div class="product-card" data-product-handle="sandal-b">
      <a href="/products/sandal-b"><h3 class="card__heading">Sandal B</h3></a>
      <span class="price">₹599.00</span>
    </div>
  </div>
</body></html>`;
    const result = await extractListingContent({
      url: "https://example.myshopify.com/collections/sale",
      html,
      title: "Sale",
    });
    assert.match(String(result.extraction_source), /dom_listing|json_ld/);
    assert.ok(result.products.length >= 1);
    assert.match(result.content, /Sandal/);
  } finally {
    axios.get = orig;
  }
});
