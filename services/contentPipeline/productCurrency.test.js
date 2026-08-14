const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { extractProductContent } = require("./extractors/product");

function shopifyProductJson(price, extra = {}) {
  return JSON.stringify({
    product: {
      title: extra.title || "Lip Scrub Mask 2 in 1 (LIMITED TIME)",
      handle: extra.handle || "lip-scrub-mask-2-in-1",
      vendor: "Mink Envy Lashes",
      options: [{ name: "Title" }],
      variants: [
        {
          price: String(price),
          compare_at_price: extra.compare_at_price || null,
          sku: extra.sku || "LIP-001",
          option1: extra.option1 || "Default Title",
          option2: extra.option2 || null,
          available: extra.available !== false,
          price_currency: extra.price_currency || undefined,
        },
      ],
    },
  });
}

test("PDP: India HTML Rs + unlocalized .json 5.99 uses shop $ money_format", async () => {
  const orig = axios.get;
  axios.get = async () => ({ data: shopifyProductJson("5.99") });
  try {
    const result = await extractProductContent({
      url: "https://www.minkenvylashes.com/products/lip-scrub-mask-2-in-1",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <script>Shopify.money_format = "\${{amount}}";</script>
          <script>var shopCurrency = "USD";</script>
          <p>India (INR ₹)</p>
          <div class="product__info-wrapper">
            <h1>Lip Scrub Mask 2 in 1 (LIMITED TIME)</h1>
            <span class="price">Rs. 577.00</span>
          </div>
        </body></html>
      `,
      jsonLdBlocks: [
        {
          "@type": "Product",
          name: "Lip Scrub Mask 2 in 1 (LIMITED TIME)",
          offers: { price: "577.00", priceCurrency: "INR" },
        },
      ],
    });
    assert.equal(result.attributes.price, 5.99);
    assert.equal(result.attributes.currency, "USD");
    assert.match(result.content, /\$5\.99/);
    assert.doesNotMatch(result.content, /₹5\.99/);
    assert.doesNotMatch(result.content, /₹577/);
  } finally {
    axios.get = orig;
  }
});

test("PDP: India HTML Rs.900 must not attach INR to unlocalized .json 8.99", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: shopifyProductJson("8.99", {
      title: "Mya – Super Natural Lash",
      handle: "mya",
      sku: "MYA-001",
    }),
  });
  try {
    const result = await extractProductContent({
      url: "https://www.minkenvylashes.com/products/mya",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <p>India (INR ₹)</p>
          <div class="product__info-wrapper">
            <h1>Mya – Super Natural Lash</h1>
            <span class="price">Rs. 900.00</span>
          </div>
        </body></html>
      `,
      jsonLdBlocks: [
        {
          "@type": "Product",
          name: "Mya – Super Natural Lash",
          offers: { price: "900.00", priceCurrency: "INR" },
        },
      ],
    });
    assert.equal(result.attributes.price, 8.99);
    assert.equal(result.attributes.currency, undefined);
    assert.match(result.content, /- Price: 8\.99/);
    assert.doesNotMatch(result.content, /₹8\.99/);
  } finally {
    axios.get = orig;
  }
});

test("PDP: same-market India .json 900 + Rs. 900 → ₹900", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: shopifyProductJson("900.00", { handle: "mya", sku: "MYA-001" }),
  });
  try {
    const result = await extractProductContent({
      url: "https://www.minkenvylashes.com/products/mya",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"96.38402625"};</script>
          <div class="product__info-wrapper">
            <span class="price">Rs. 900.00</span>
          </div>
        </body></html>
      `,
      jsonLdBlocks: [
        {
          "@type": "Product",
          name: "Mya",
          offers: { price: "900.00", priceCurrency: "INR" },
        },
      ],
    });
    assert.equal(result.attributes.price, 900);
    assert.equal(result.attributes.currency, "INR");
    assert.match(result.content, /₹900/);
  } finally {
    axios.get = orig;
  }
});

test("PDP: Blue Tyga shopify_json 1799.00 INR is major units not cents", async () => {
  const orig = axios.get;
  axios.get = async () => ({
    data: shopifyProductJson("1799.00", {
      title: "Office Jogger Air Stretch",
      handle: "office-jogger-air-stretch",
      sku: "OFFICE JOGGER OJE0005 LIGHT_GREY 30",
      option1: "Light Grey",
      option2: "30",
      compare_at_price: "2999.00",
      price_currency: "INR",
    }),
  });
  try {
    const result = await extractProductContent({
      url: "https://bluetyga.com/products/office-jogger-air-stretch",
      html: `
        <html><body>
          <script>Shopify.currency = {"active":"INR","rate":"1.0"};</script>
          <div class="product__info-wrapper">
            <h1>Office Jogger Air Stretch</h1>
            <span class="price">₹1,799</span>
            <span class="price--compare">₹2,999</span>
          </div>
        </body></html>
      `,
      jsonLdBlocks: [
        {
          "@type": "Product",
          name: "Office Jogger Air Stretch",
          offers: { price: "1799.00", priceCurrency: "INR" },
        },
      ],
    });
    assert.equal(result.attributes.price, 1799);
    assert.equal(result.attributes.original_price, 2999);
    assert.equal(result.attributes.currency, "INR");
    assert.match(result.content, /₹1799/);
    assert.match(result.content, /₹2999/);
    assert.doesNotMatch(result.content, /₹17\.99/);
    assert.doesNotMatch(result.content, /₹29\.99/);
  } finally {
    axios.get = orig;
  }
});
