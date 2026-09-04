const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSameSiteUrl,
  looksLikeWafChallenge,
  hasUsableScrapedHtml,
  getHttpStatusFromError,
  classifyHttpStatus,
  isWafHttpStatus,
} = require("./webUrlUtils");

function absoluteUrl(host, path = "/") {
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return `https://${host}${pathname}`;
}

test("isSameSiteUrl allows www vs apex on the same host", () => {
  const host = "example.com";
  assert.equal(
    isSameSiteUrl(
      absoluteUrl(`www.${host}`, "/sitemap.xml"),
      absoluteUrl(host, "/"),
    ),
    true,
  );
  assert.equal(
    isSameSiteUrl(
      absoluteUrl(host, "/page-sitemap.xml"),
      absoluteUrl(`www.${host}`, "/"),
    ),
    true,
  );
});

test("isSameSiteUrl rejects third-party robots sitemaps", () => {
  const siteHost = "example.com";
  const siteOrigin = absoluteUrl(`www.${siteHost}`, "/");
  assert.equal(
    isSameSiteUrl(absoluteUrl("cdn.third-party.test", "/sitemap/1.xml"), siteOrigin),
    false,
  );
  assert.equal(
    isSameSiteUrl(absoluteUrl("www.other-domain.test", "/sitemap.xml"), siteOrigin),
    false,
  );
});

test("looksLikeWafChallenge detects Cloudflare interstitial copy", () => {
  assert.equal(looksLikeWafChallenge("<html><title>Just a moment...</title></html>"), true);
  assert.equal(
    looksLikeWafChallenge('<div id="challenge-platform">checking your browser</div>'),
    true,
  );
  assert.equal(looksLikeWafChallenge("<html><h1>Welcome</h1></html>"), false);
});

test("looksLikeWafChallenge ignores challenge tokens only inside scripts", () => {
  const html = [
    "<html><head><title>Store Home</title>",
    "<script>window.namespace = 'challenge-platform';</script></head>",
    "<body><h1>Welcome to the store</h1>",
    "<p>Shop jerseys, hats, and equipment for the whole family this season.</p>",
    "<p>Find hours, events, and directions on this page.</p>",
    "<a href='/shop'>Shop</a> <a href='/about'>About</a> <a href='/contact'>Contact</a>",
    "<a href='/events'>Events</a> <a href='/teams'>Teams</a>",
    "</body></html>",
  ].join("");
  assert.equal(looksLikeWafChallenge(html), false);
  assert.equal(hasUsableScrapedHtml(html), true);
});

test("hasUsableScrapedHtml rejects a short challenge page", () => {
  assert.equal(
    hasUsableScrapedHtml("<html><title>Just a moment...</title><body>Checking your browser</body></html>"),
    false,
  );
});

test("classifyHttpStatus separates WAF from missing sitemaps", () => {
  assert.equal(classifyHttpStatus(200), "ok");
  assert.equal(classifyHttpStatus(404), "not_found");
  assert.equal(classifyHttpStatus(403), "waf");
  assert.equal(classifyHttpStatus(429), "waf");
  assert.equal(classifyHttpStatus(407), "proxy_auth");
  assert.equal(isWafHttpStatus(403), true);
  assert.equal(isWafHttpStatus(404), false);
});

test("getHttpStatusFromError reads axios and message shapes", () => {
  const blockedUrl = absoluteUrl("example.com", "/sitemap.xml");
  assert.equal(getHttpStatusFromError({ response: { status: 403 } }), 403);
  assert.equal(
    getHttpStatusFromError(new Error(`HTTP 403 for ${blockedUrl}`)),
    403,
  );
  assert.equal(getHttpStatusFromError(new Error("socket hang up")), null);
});
