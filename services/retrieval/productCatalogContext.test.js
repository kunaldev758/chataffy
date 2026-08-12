const assert = require("assert");
const {
  extractProductsFromText,
  partitionProductsFromMatches,
  buildControlledCatalogContext,
} = require("./productCatalogContext");

function run() {
  const listingText = `
# Course Catalog
https://examnest.example/courses

## Product

Name:
Pragyaan - CAT Complete Course

Price:
₹14,000

Product URL:
https://examnest.example/pragyaan

## Product

Name:
Daksh - CAT Complete Course

Price:
₹29,000

Availability:
In Stock
`.trim();

  const products = extractProductsFromText(listingText, {
    pageUrl: "https://examnest.example/courses",
    entityType: "listing",
  });
  assert.strictEqual(products.length, 2);
  assert.strictEqual(products[0].url, "https://examnest.example/pragyaan");
  assert.strictEqual(products[1].url, null, "listing page URL must not promote unlinked products");

  const matches = [
    {
      score: 0.9,
      payload: {
        url: "https://examnest.example/courses",
        entity_type: "listing",
        text: listingText,
      },
    },
    {
      score: 0.8,
      payload: {
        url: "https://examnest.example/tejas",
        entity_type: "product",
        text: `# Tejas - CAT Self-Paced Course\n\nProduct URL:\nhttps://examnest.example/tejas\n\n- Price: ₹24,000`,
      },
    },
  ];

  const { mainCatalog, suggestionOnly } = partitionProductsFromMatches(matches);
  assert.ok(mainCatalog.some((p) => /Pragyaan/i.test(p.name)));
  assert.ok(mainCatalog.some((p) => /Tejas/i.test(p.name)));
  assert.ok(suggestionOnly.some((p) => /Daksh/i.test(p.name)));
  assert.ok(
    !mainCatalog.some((p) => /Daksh/i.test(p.name)),
    "Daksh must stay suggestion-only",
  );

  const { context, mainCount, suggestionCount } = buildControlledCatalogContext(
    matches,
    { maxTotalChars: 4000 },
  );
  assert.ok(context);
  assert.ok(context.includes("## MAIN CATALOG"));
  assert.ok(context.includes("## SUGGESTION-ONLY"));
  assert.ok(context.includes("Pragyaan"));
  assert.ok(context.includes("Daksh"));
  assert.ok(mainCount >= 2);
  assert.strictEqual(suggestionCount, 1);

  // PDP without inline Product URL still links via entity page URL
  const pdpOnly = extractProductsFromText(
    `# Agrani - IPMAT Complete Course\n\n- Price: ₹39,000`,
    {
      pageUrl: "https://examnest.example/agrani",
      entityType: "product",
    },
  );
  assert.strictEqual(pdpOnly.length, 1);
  assert.strictEqual(pdpOnly[0].url, "https://examnest.example/agrani");

  console.log("productCatalogContext tests passed");
}

run();
