const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const {
  extractListingContent,
  mapShopifyCollectionProduct,
  shopifyCollectionPath,
  extractShopifyCurrencyActive,
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
          <script>Shopify.currency = {"active":"INR","rate":"1.0"};</script>
          <script>var price = "$0";</script>
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
    assert.equal(result.products[0].currency, "INR");
    assert.equal(result.products[1].price, 949);
    assert.match(result.content, /Style 6004/);
    assert.match(result.content, /₹689/);
    assert.doesNotMatch(result.content, /\$689/);
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
    assert.match(result.content, /\$150/);
    assert.equal(result.products[0].currency, "$");
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
    assert.equal(result.products[0].currency, "INR");
    assert.match(result.content, /₹499/);
    assert.doesNotMatch(result.content, /\$499/);
  } finally {
    axios.get = orig;
  }
});

test("extractShopifyCurrencyActive reads ISO only from Shopify.currency", () => {
  assert.equal(
    extractShopifyCurrencyActive(
      `Shopify.currency = {"active":"USD","rate":"1.0"}; offers, chairs, ₹`,
    ),
    "USD",
  );
  assert.equal(
    extractShopifyCurrencyActive(`Shopify.currency = {'active':'INR'}; $0 scripts`),
    "INR",
  );
  assert.equal(
    extractShopifyCurrencyActive(`<p>offers, chairs, Rs. 12 tables</p>`),
    "",
  );
  assert.equal(
    extractShopifyCurrencyActive(
      `${"x".repeat(5000)}Shopify.currency = {"active":"EUR","rate":"1.0"};`,
    ),
    "EUR",
  );
  assert.equal(
    extractShopifyCurrencyActive(
      `Shopify.currencyFormats={}; Shopify.currency = {"active":"INR","rate":"83.2"}; India (INR ₹)`,
    ),
    "",
  );
  assert.equal(
    extractShopifyCurrencyActive(`<p>India (INR ₹) Nepal (NPR Rs.)</p>`),
    "",
  );
});

test("Dawn card: numeric data-product-price does not block later $ token", async () => {
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
    <div class="product-card" data-product-handle="mya">
      <a href="/products/mya"><h3 class="card__heading">Mya – Super Natural Lash</h3></a>
      <span data-product-price="8.99">8.99</span>
      <span class="price-item--sale">$8.99</span>
    </div>
  </div>
</body></html>`;
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/super-natural-10-12mm",
      html,
      title: "Super Natural Mink 10-12mm",
    });
    assert.ok(result.products.length >= 1);
    assert.equal(result.products[0].price, 8.99);
    assert.equal(result.products[0].currency, "$");
    assert.match(result.content, /\$8\.99/);
  } finally {
    axios.get = orig;
  }
});

test("Annie's-style copy does not become INR; USD active formats as $", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Round Dining table",
          handle: "dining-table-storage-desk-kitchen-table",
          vendor: "Annie's Comfort Corner",
          variants: [{ price: "250.99", available: true }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://anniescomfortcorner.com/collections/tables-chairs",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"USD","rate":"1.0"};</script>
          <p>Explore tables & chairs, plus exclusive offers, new arrivals.</p>
          <span class="price">$250.99</span>
        </body></html>
      `,
      title: "Tables & Chairs",
    });
    assert.equal(result.products[0].price, 250.99);
    assert.equal(result.products[0].currency, "USD");
    assert.match(result.content, /\$250\.99/);
    assert.doesNotMatch(result.content, /₹/);
  } finally {
    axios.get = orig;
  }
});

test("Shopify collection omits currency glyph when none is structured", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Round Dining table",
          handle: "dining-table",
          variants: [{ price: "250.99", available: true }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://example.myshopify.com/collections/tables-chairs",
      html: `<html><body><p>offers, chairs, more</p></body></html>`,
      title: "Tables",
    });
    assert.equal(result.products[0].price, 250.99);
    assert.equal(result.products[0].currency, undefined);
    assert.match(result.content, /\nPrice:\n250\.99/);
    assert.doesNotMatch(result.content, /\$250/);
    assert.doesNotMatch(result.content, /₹250/);
  } finally {
    axios.get = orig;
  }
});

test("Mink Envy: presentment INR rate is not applied to products.json USD amounts", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Lip Scrub Mask 2 in 1 (LIMITED TIME)",
          handle: "lip-scrub-mask-2-in-1",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "5.99", available: false }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/lip-scrub-balm",
      html: `
        <html><body>
          <script>Shopify.currencyFormats = {"INR":"₹{{amount}}"};</script>
          <script>Shopify.currency = {"active":"INR","rate":"83.2"};</script>
          <p>India (INR ₹) Nepal (NPR Rs.) United States (USD $)</p>
          <div id="product-grid" class="product-grid">
            <div class="product-card" data-product-handle="lip-scrub-mask-2-in-1">
              <a href="/products/lip-scrub-mask-2-in-1?_pos=1&_fid=abc">
                <h3 class="card__heading">Lip Scrub Mask 2 in 1 (LIMITED TIME)</h3>
              </a>
              <span class="price-item--sale">$5.99</span>
            </div>
          </div>
        </body></html>
      `,
      title: "Lip Scrubs & Balm",
    });
    assert.equal(result.products[0].price, 5.99);
    assert.equal(result.products[0].currency, "$");
    assert.match(result.content, /\$5\.99/);
    assert.doesNotMatch(result.content, /₹/);
  } finally {
    axios.get = orig;
  }
});

test("Mink Envy lashes: query-string PDP URLs still pick up $ from the card", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Mya – Super Natural Lash (10–12mm) (LIMITED TIME)",
          handle: "mya",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "8.99", available: true }],
        },
        {
          title: "Brea – Barely-There Lash (10–12mm)",
          handle: "brea",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "12.99", available: true }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/super-natural-10-12mm",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"83.2"};</script>
          <p>India (INR ₹)</p>
          <div id="product-grid" class="product-grid">
            <div class="product-card" data-product-handle="mya">
              <a href="/products/mya?_pos=1&_sid=xyz"><h3 class="card__heading">Mya – Super Natural Lash (10–12mm) (LIMITED TIME)</h3></a>
              <span class="price">$8.99</span>
            </div>
            <div class="product-card" data-product-handle="brea">
              <a href="/products/brea?_pos=2"><h3 class="card__heading">Brea – Barely-There Lash (10–12mm)</h3></a>
              <span class="price">$12.99</span>
            </div>
          </div>
        </body></html>
      `,
      title: "Super Natural Mink 10-12mm – Mink Envy Lashes",
    });
    assert.equal(result.products[0].price, 8.99);
    assert.equal(result.products[0].currency, "$");
    assert.match(result.content, /\$8\.99/);
    assert.match(result.content, /\$12\.99/);
    assert.doesNotMatch(result.content, /\nPrice:\n8\.99\n/);
    assert.doesNotMatch(result.content, /₹/);
  } finally {
    axios.get = orig;
  }
});

test("Mink Envy: India HTML Rs.900 must not attach INR to unlocalized JSON 8.99", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Mya – Super Natural Lash (10–12mm) (LIMITED TIME)",
          handle: "mya",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "8.99", available: true }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/super-natural-10-12mm",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <p>India (INR ₹)</p>
          <div id="product-grid" class="product-grid">
            <div class="product-card" data-product-handle="mya">
              <a href="/products/mya"><h3 class="card__heading">Mya – Super Natural Lash (10–12mm) (LIMITED TIME)</h3></a>
              <span class="price">Rs. 900.00</span>
            </div>
          </div>
        </body></html>
      `,
      title: "Super Natural Mink 10-12mm",
    });
    assert.equal(result.products[0].price, 8.99);
    assert.equal(result.products[0].currency, undefined);
    assert.match(result.content, /\nPrice:\n8\.99/);
    assert.doesNotMatch(result.content, /₹8\.99/);
    assert.doesNotMatch(result.content, /₹900/);
  } finally {
    axios.get = orig;
  }
});

test("Mink Envy: unlocalized JSON 5.99 + India Rs card uses shop $ money_format", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Lip Scrub Mask 2 in 1 (LIMITED TIME)",
          handle: "lip-scrub-mask-2-in-1",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "5.99", available: false }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/lip-scrub-balm",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <script>Shopify.money_format = "\${{amount}}";</script>
          <script>var shopCurrency = "USD";</script>
          <p>India (INR ₹)</p>
          <div id="product-grid" class="product-grid">
            <div class="product-card" data-product-handle="lip-scrub-mask-2-in-1">
              <a href="/products/lip-scrub-mask-2-in-1">
                <h3 class="card__heading">Lip Scrub Mask 2 in 1 (LIMITED TIME)</h3>
              </a>
              <span class="price">Rs. 577.00</span>
            </div>
          </div>
        </body></html>
      `,
      title: "Lip Scrubs & Balm – Mink Envy Lashes",
    });
    assert.equal(result.products[0].price, 5.99);
    assert.equal(result.products[0].currency, "USD");
    assert.match(result.content, /\$5\.99/);
    assert.doesNotMatch(result.content, /₹5\.99/);
    assert.doesNotMatch(result.content, /₹577/);
  } finally {
    axios.get = orig;
  }
});

test("Mink Envy: same-market India JSON 900 + Rs. 900 → ₹900", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: JSON.stringify({
      products: [
        {
          title: "Mya – Super Natural Lash (10–12mm) (LIMITED TIME)",
          handle: "mya",
          vendor: "Mink Envy Lashes",
          variants: [{ price: "900.00", available: true }],
        },
      ],
    }),
  });
  try {
    const result = await extractListingContent({
      url: "https://www.minkenvylashes.com/collections/super-natural-10-12mm",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <div id="product-grid" class="product-grid">
            <div class="product-card" data-product-handle="mya">
              <a href="/products/mya"><h3 class="card__heading">Mya – Super Natural Lash (10–12mm) (LIMITED TIME)</h3></a>
              <span class="price">Rs. 900.00</span>
            </div>
          </div>
        </body></html>
      `,
      title: "Super Natural Mink 10-12mm",
    });
    assert.equal(result.products[0].price, 900);
    assert.equal(result.products[0].currency, "INR");
    assert.match(result.content, /₹900/);
    assert.doesNotMatch(result.content, /₹8\.99/);
  } finally {
    axios.get = orig;
  }
});
