const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeShopifyProduct,
  collectFromShopify,
} = require("./extractors/productVariants");
const {
  productToMarkdown,
  uniqueProductEnrichment,
  extractProductContent,
} = require("./extractors/product");
const {
  productHtmlFragmentToMarkdown,
  isUsefulProductMarkdown,
  extractCleanProductBody,
} = require("./htmlCleanup");
const {
  countTokens,
  splitByTokens,
} = require("../ingestion/tokenSplitter");

const SHOPIFY_PRODUCT = {
  id: 9012633796864,
  title: "Womens 2D AIR TEE",
  body_html:
    "<p>Ultra-light everyday tee with sweat-wicking performance.</p>",
  vendor: "Blue Tyga",
  product_type: "T Shirt",
  tags: "Women, Travel Wear, Lightweight",
  options: [
    { name: "Color", values: ["OFF White", "BLACK"] },
    { name: "Size", values: ["S", "M"] },
  ],
  variants: [
    {
      id: 101,
      title: "OFF White / S",
      option1: "OFF White",
      option2: "S",
      sku: "WHITE-S",
      price: 129900,
      compare_at_price: 199900,
      available: true,
      price_currency: "INR",
    },
    {
      id: 102,
      title: "BLACK / M",
      option1: "BLACK",
      option2: "M",
      sku: "BLACK-M",
      price: 129900,
      compare_at_price: 199900,
      available: false,
      price_currency: "INR",
    },
  ],
};

test("normalizes Shopify root content and complete variant attributes", () => {
  const normalized = normalizeShopifyProduct(SHOPIFY_PRODUCT, {
    pricesInCents: true,
  });

  assert.equal(normalized.title, "Womens 2D AIR TEE");
  assert.match(normalized.bodyHtml, /Ultra-light/);
  assert.equal(normalized.attributes.price, 1299);
  assert.equal(normalized.attributes.original_price, 1999);
  assert.equal(normalized.attributes.product_type, "T Shirt");
  assert.deepEqual(normalized.attributes.colors, ["OFF White", "BLACK"]);
  assert.deepEqual(normalized.attributes.sizes, ["S", "M"]);
  assert.equal(normalized.attributes.variants[0].id, "101");
  assert.equal(normalized.attributes.variants[1].in_stock, false);
});

test("keeps variants in compact product Markdown", () => {
  const normalized = normalizeShopifyProduct(SHOPIFY_PRODUCT, {
    pricesInCents: true,
  });
  const markdown = productToMarkdown({
    entity_name: normalized.title,
    description: productHtmlFragmentToMarkdown(normalized.bodyHtml),
    attributes: normalized.attributes,
    url: "https://example.com/products/tee",
  });

  assert.match(markdown, /^# Womens 2D AIR TEE/m);
  assert.match(markdown, /## Variants/);
  assert.match(markdown, /OFF White \/ S — ₹1299 — \(was ₹1999\)/);
  assert.match(markdown, /BLACK \/ M.*Out of stock/);
  assert.doesNotMatch(markdown, /199900/);
});

test("rejects noisy PDP enrichment but keeps unique product prose", () => {
  const description = "Ultra-light everyday tee with sweat-wicking performance.";
  const noisy = [
    "Your cart is empty",
    "Continue shopping",
    "Search",
    ...Array.from(
      { length: 20 },
      (_, i) => `[Product ${i}](https://cdn.shopify.com/product-${i})`,
    ),
  ].join("\n\n");
  assert.equal(uniqueProductEnrichment(noisy, description), "");

  const useful =
    "## Care instructions\n\nMachine wash cold with similar colours. Do not bleach. Dry in shade to preserve the breathable performance fabric.";
  assert.equal(isUsefulProductMarkdown(useful), true);
  assert.match(uniqueProductEnrichment(useful, description), /Machine wash cold/);
});

test("hard-splits an oversized single line without truncating its tail", () => {
  const hugeLine = Array.from({ length: 12000 }, (_, i) => `token${i}`).join(" ");
  const chunks = splitByTokens(hugeLine, 350, 50);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => countTokens(chunk) <= 350));
  assert.match(chunks[chunks.length - 1], /token11999/);
});

test("embedded Shopify HTML exposes body_html package without a network fetch", () => {
  const html = `
    <html><body>
      <script type="application/json">
        ${JSON.stringify(SHOPIFY_PRODUCT)}
      </script>
      <main>
        <a href="/cart">Your cart is empty</a>
        <img src="https://cdn.shopify.com/files/gallery-1.webp" alt="tee" />
        <img src="https://cdn.shopify.com/files/gallery-2.webp" alt="tee" />
      </main>
    </body></html>
  `;
  const { attrs, shopifyProduct } = collectFromShopify(html);
  assert.equal(shopifyProduct.title, "Womens 2D AIR TEE");
  assert.match(shopifyProduct.bodyHtml, /Ultra-light/);
  assert.equal(attrs.original_price, 1999);
  assert.equal(attrs.variants.length, 2);
});

test("Shopify-primary extract keeps variants and rejects gallery/cart noise", async () => {
  const html = `
    <html><body>
      <header>Menu Search Cart</header>
      <main class="product">
        <h1>Womens 2D AIR TEE - OFF White / S</h1>
        <div class="product__description">
          <p>Ultra-light everyday tee with sweat-wicking performance.</p>
        </div>
        <p>Your cart is empty</p>
        <a href="/collections/all">Continue shopping</a>
        ${Array.from(
          { length: 12 },
          (_, i) =>
            `<img src="https://cdn.shopify.com/files/artboard-${i}.webp" alt="Womens 2D AIR TEE" />`,
        ).join("\n")}
        <section>
          <h2>Care</h2>
          <p>Machine wash cold. Do not bleach. Dry in shade to preserve fabric performance.</p>
        </section>
      </main>
    </body></html>
  `;

  // Avoid network: use a non-Shopify product URL shape while still injecting
  // Shopify package through embedded HTML + collectCanonicalProductAttrs path.
  const result = await extractProductContent({
    url: "https://example.com/item/womens-2d-air-tee",
    html: `${html}
      <script type="application/json">${JSON.stringify({
        ...SHOPIFY_PRODUCT,
        variants: SHOPIFY_PRODUCT.variants.map((v) => ({
          ...v,
          price: "1299.00",
          compare_at_price: "1999.00",
        })),
      })}</script>`,
    jsonLdBlocks: [],
  });

  assert.match(result.content, /^# Womens 2D AIR TEE/m);
  assert.match(result.content, /## Variants/);
  assert.match(result.content, /OFF White \/ S — ₹1299/);
  assert.match(result.content, /## Description/);
  assert.match(result.content, /Ultra-light everyday tee/);
  assert.doesNotMatch(result.content, /Your cart is empty/);
  assert.doesNotMatch(result.content, /cdn\.shopify\.com\/files\/artboard/);
  assert.ok(result.attributes.variants.length >= 2);
});

test("extractCleanProductBody strips CDN image walls from PDP markdown", () => {
  const html = `
    <main>
      <div class="product__description">
        <p>Breathable travel tee designed for hot climates and long commutes.</p>
        <img src="https://cdn.shopify.com/a.webp" alt="tee" />
        <img src="https://cdn.shopify.com/b.webp" alt="tee" />
      </div>
    </main>
  `;
  const { markdown } = extractCleanProductBody(
    html,
    "https://example.com/products/tee",
  );
  assert.match(markdown, /Breathable travel tee/);
  assert.doesNotMatch(markdown, /cdn\.shopify\.com/);
});
