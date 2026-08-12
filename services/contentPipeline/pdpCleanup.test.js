const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeProductMarkdown,
  isLowValueResidual,
} = require("./sanitizeProductMarkdown");
const {
  countTokens,
  splitByTokens,
  ensureEmbedTokenLimit,
  hardSplitByTokens,
} = require("../ingestion/tokenSplitter");
const {
  productToMarkdown,
  normalizeShopifyCentsFields,
} = require("./extractors/product");

test("sanitizeProductMarkdown removes Shopify JSON blobs and keeps prose", () => {
  const input = [
    "# Anti-Chafing Undies",
    "",
    "Meet the Anti-Chafing Undies built for movement.",
    "",
    '{ "id": 9326019674368, "title": "Anti-Chafing Undies", "variants": [{"id":1,"price":"69900"}], "media": [], "featured_image": {"src":"//x"} }',
    "",
    "The 7 inch inseam eliminates chafing.",
  ].join("\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.equal(stats.hadJsonBlob, true);
  assert.match(text, /Meet the Anti-Chafing Undies/);
  assert.match(text, /7 inch inseam/);
  assert.doesNotMatch(text, /"variants"/);
  assert.doesNotMatch(text, /featured_image/);
});

test("sanitizeProductMarkdown removes images, CSS, and cart UI chrome", () => {
  const input = [
    "Your cart is empty",
    "Continue shopping",
    "![Anti-Chafing Undies](https://bluetyga.com/cdn/shop/files/foo.webp?v=1)",
    "https://cdn.shopify.com/s/files/1/x/bar.jpg",
    "#shopify-section-template--225__related-products { --x: 0; }",
    "Engineered for comfort and durability.",
  ].join("\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedImages >= 1);
  assert.ok(stats.removedCss >= 1 || stats.removedUi >= 1);
  assert.match(text, /Engineered for comfort/);
  assert.doesNotMatch(text, /!\[/);
  assert.doesNotMatch(text, /cdn\/shop/);
  assert.doesNotMatch(text, /Your cart is empty/i);
});

test("sanitizeProductMarkdown strips markdown images with &amp; and COD.svg badges", () => {
  const input = [
    "Product copy stays.",
    "![Anti-Chafing Undies](https://bluetyga.com/cdn/shop/files/siliconegripperathleticunderwear.webp?v=1768973964&amp;width=3400)",
    "https://cdn.shopify.com/s/files/1/0446/5629/6087/files/COD.svg",
    "Cash On Delivery",
    "Secure Payment",
  ].join("\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedImages >= 2);
  assert.match(text, /Product copy stays/);
  assert.doesNotMatch(text, /siliconegripper/);
  assert.doesNotMatch(text, /COD\.svg/i);
  assert.doesNotMatch(text, /!\[/);
  assert.doesNotMatch(text, /Cash On Delivery/i);
});

test("sanitizeProductMarkdown removes Shopify variant JSON arrays", () => {
  const variants = [
    {
      id: 48228501422336,
      title: "Black / (M) - 28–30 = 70–75 cm",
      option1: "Black",
      option2: "(M) - 28–30 = 70–75 cm",
      sku: "ANTI SHAFING UNDIES UGE0007 BLACK M",
      requires_shipping: true,
      taxable: true,
      featured_image: {
        id: 45728377864448,
        product_id: 9326019674368,
        src: "//bluetyga.com/cdn/shop/files/siliconegripperathleticunderwear.webp?v=1768973964",
        variant_ids: [48228501422336],
      },
      available: true,
      price: 69900,
      compare_at_price: 99900,
      inventory_management: "shopify",
      featured_media: {
        id: 37445857116416,
        preview_image: {
          src: "//bluetyga.com/cdn/shop/files/siliconegripperathleticunderwear.webp?v=1768973964",
        },
      },
      requires_selling_plan: false,
      selling_plan_allocations: [],
      quantity_rule: { min: 1, max: null, increment: 1 },
    },
    {
      id: 48228501455104,
      title: "Black / (L)",
      option1: "Black",
      sku: "ANTI SHAFING UNDIES UGE0007 BLACK L",
      requires_shipping: true,
      featured_image: { src: "//x/cdn/shop/files/x.webp" },
      price: 69900,
      inventory_management: "shopify",
      available: true,
    },
  ];

  const input = [
    "# Anti-Chafing Undies",
    "Soft polyamide blend for all-day comfort.",
    JSON.stringify(variants),
    "Keep this FAQ-like prose about the 7 inch inseam.",
  ].join("\n\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.hadJsonBlob || stats.removedJson >= 1);
  assert.match(text, /Soft polyamide blend/);
  assert.match(text, /7 inch inseam/);
  assert.doesNotMatch(text, /48228501422336/);
  assert.doesNotMatch(text, /featured_image/);
  assert.doesNotMatch(text, /selling_plan_allocations/);
  assert.doesNotMatch(text, /inventory_management/);
});

test("sanitizeProductMarkdown removes escaped markdown variant dumps without parse", () => {
  // Mimics turndown-escaped Shopify dumps that fail JSON.parse
  const escaped = `[{"id":48228501422336,"title":"Black \\\\/ (M)","option1":"Black","sku":"X","requires\\_shipping":true,"featured\\_image":{"src":"\\\\/\\\\/bluetyga.com\\\\/cdn\\\\/shop\\\\/files\\\\/x.webp"},"price":69900,"inventory\\_management":"shopify","selling\\_plan\\_allocations":[],"quantity\\_rule":{"min":1}}]`;
  const input = `Intro prose about fit.\n\n${escaped}\n\nOutro about fabric.`;
  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedJson >= 1 || stats.hadJsonBlob);
  assert.match(text, /Intro prose about fit/);
  assert.match(text, /Outro about fabric/);
  assert.doesNotMatch(text, /featured/);
  assert.doesNotMatch(text, /48228501422336/);
});

test("sanitizeProductMarkdown dedupes exact repeated feature blocks", () => {
  const block = [
    "01 Anti-Chafing Comfort",
    "Say goodbye to thigh burn and irritation with the optimised 7-inch inseam.",
  ].join("\n");
  const input = `${block}\n\n${block}\n\nUnique closing note about fabric softness.`;
  const { text, stats } = sanitizeProductMarkdown(input);
  assert.equal(stats.removedDupes, 1);
  assert.equal((text.match(/Anti-Chafing Comfort/g) || []).length, 1);
  assert.match(text, /Unique closing note/);
});

test("sanitizeProductMarkdown removes broken product object with variants orphan", () => {
  // Mimics partial-strip wreckage: product object + `"variants":\`
  const broken = [
    '{"id":9326019674368,"title":"Anti-Chafing Undies","handle":"anti-chafing-undies",',
    '"variants":\\ ,"images":[{"src":"//x/cdn/shop/files/a.webp"}],',
    '"featured\\_image":{"src":"//x/cdn/shop/files/a.webp"},',
    '"media":[{"id":1,"preview\\_image":{"src":"//x"}}],',
    '"selling\\_plan\\_allocations":[],"requires\\_shipping":true}',
  ].join("");

  const input = [
    "Meet the Anti-Chafing Undies built for movement.",
    broken,
    "## Engineer's Notes",
    "Gripper elastic stays put during runs.",
  ].join("\n\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedJson >= 1 || stats.removedOrphans >= 1);
  assert.match(text, /Meet the Anti-Chafing Undies/);
  assert.match(text, /Engineer's Notes/);
  assert.match(text, /Gripper elastic/);
  assert.doesNotMatch(text, /9326019674368/);
  assert.doesNotMatch(text, /"variants"\s*:/);
  assert.doesNotMatch(text, /featured_image|featured\\_image/);
});

test("sanitizeProductMarkdown strips PDP chrome lines without eating prose ATC", () => {
  const input = [
    "Skip to content",
    "Share",
    "Zoom",
    "×",
    "Add to cart",
    "You may also like",
    "[Other Shorts](https://bluetyga.com/products/other)",
    "₹699",
    "Exclusive offers",
    "Real copy: athletes add to cart when sizing is clear.",
    "Engineered for long runs.",
  ].join("\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedUi >= 4);
  assert.match(text, /athletes add to cart when sizing is clear/);
  assert.match(text, /Engineered for long runs/);
  assert.doesNotMatch(text, /^Add to cart$/m);
  assert.doesNotMatch(text, /Skip to content/i);
  assert.doesNotMatch(text, /You may also like/i);
  assert.doesNotMatch(text, /Exclusive offers/i);
});

test("sanitizeProductMarkdown dedupes repeated short 01–05 headings", () => {
  const input = [
    "01 Anti-Chafing Comfort",
    "",
    "02 Stay-Put Gripper",
    "",
    "01 Anti-Chafing Comfort",
    "",
    "03 Breathable Mesh",
    "",
    "02 Stay-Put Gripper",
    "",
    "Keep the FAQ answer about washing cold.",
  ].join("\n");

  const { text, stats } = sanitizeProductMarkdown(input);
  assert.ok(stats.removedDupes >= 2);
  assert.equal((text.match(/01 Anti-Chafing Comfort/g) || []).length, 1);
  assert.equal((text.match(/02 Stay-Put Gripper/g) || []).length, 1);
  assert.match(text, /washing cold/);
});

test("isLowValueResidual catches related/CSS/image spam", () => {
  assert.equal(
    isLowValueResidual({
      entity_type: "general",
      content: "You may also like\n[A](https://x.com/a)\n[B](https://x.com/b)",
    }),
    true,
  );
  assert.equal(
    isLowValueResidual({
      entity_type: "general",
      content:
        "#shopify-section-x { --product-list-items-per-row: 4; } @media screen {}",
    }),
    true,
  );
  assert.equal(
    isLowValueResidual({
      entity_type: "general",
      content:
        "Care instructions: wash cold, hang dry, do not bleach. Made for long runs.",
    }),
    false,
  );
});

test("normalizeShopifyCentsFields fixes original_price 99900 when price is 699", () => {
  const attrs = normalizeShopifyCentsFields({
    price: 699,
    original_price: 99900,
    currency: "INR",
  });
  assert.equal(attrs.price, 699);
  assert.equal(attrs.original_price, 999);
});

test("productToMarkdown compactVariants summarizes instead of dumping 40 lines", () => {
  const variants = [];
  for (const color of ["Black", "Olive", "Teal"]) {
    for (const size of ["M", "L", "XL", "XXL", "S"]) {
      variants.push({
        color,
        size,
        price: 699,
        in_stock: true,
        sku: `${color}-${size}`,
      });
    }
  }
  const md = productToMarkdown({
    entity_name: "Anti-Chafing Undies",
    attributes: {
      price: 699,
      original_price: 999,
      currency: "INR",
      colors: ["Black", "Olive", "Teal"],
      sizes: ["S", "M", "L", "XL", "XXL"],
      variants,
    },
    url: "https://bluetyga.com/products/anti-chafing-undies",
    compactVariants: true,
  });
  assert.match(md, /15 variants available/);
  assert.match(md, /Black, Olive, Teal/);
  assert.match(md, /…and \d+ more/);
  assert.ok((md.match(/^\- /gm) || []).length <= 20);
});

test("splitByTokens hard-splits oversized single lines under maxTokens", () => {
  // ~1.5k tokens as one line (no newlines) — must still split
  const giant = "word ".repeat(2000).trim();
  const chunks = splitByTokens(giant, 350, 0);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(countTokens(c) <= 350, `chunk tokens=${countTokens(c)}`);
  }
});

test("ensureEmbedTokenLimit oneToOne never exceeds safe token budget", () => {
  const giant = `{ "variants": ${JSON.stringify(
    Array.from({ length: 200 }, (_, i) => ({
      id: i,
      title: "Black / XL ".repeat(40),
      price: "69900",
      featured_image: { src: "//cdn/shop/" + "x".repeat(200) },
    })),
  )} }`;
  assert.ok(countTokens(giant) > 8192);
  const { texts, splitCount } = ensureEmbedTokenLimit([giant, "short ok"], undefined, {
    oneToOne: true,
  });
  assert.equal(texts.length, 2);
  assert.ok(splitCount >= 1);
  const safe =
    Number(process.env.EMBED_SAFE_TOKENS) ||
    Math.min((Number(process.env.EMBED_MAX_TOKENS) || 8192) - 392, 7800);
  assert.ok(countTokens(texts[0]) <= safe);
  assert.equal(texts[1], "short ok");
});

test("hardSplitByTokens returns pieces within budget", () => {
  const parts = hardSplitByTokens("hello world ".repeat(5000), 100);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(countTokens(p) <= 100);
  }
});
