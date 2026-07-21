const { chromium } = require("playwright");
const config = require("../config/scraper");

const MAX_CONCURRENT_PAGES = parseInt(process.env.BROWSER_SCRAPE_CONCURRENCY || "2", 10);
const MAX_PER_USER = parseInt(process.env.BROWSER_SCRAPE_PER_USER || "1", 10);
const MAX_PER_JOB = parseInt(process.env.BROWSER_SCRAPE_PER_JOB || "1", 10);
const NAV_TIMEOUT_MS = 30000;
// Best-effort only — many SPAs keep a connection open forever (polling/websockets/analytics)
// and never truly go idle
const NETWORK_IDLE_TIMEOUT_MS = parseInt(process.env.BROWSER_SCRAPE_NETWORKIDLE_TIMEOUT_MS || "5000", 10);


function toPlaywrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const proxy = {
      server: `${parsed.protocol}//${parsed.host}`,
    };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    return proxy;
  } catch {
    return { server: proxyUrl };
  }
}

/**
 * FIFO concurrency gate. Releasing transfers the slot to a waiter when present
 * so the active count never overshoots the limit under contention.
 */
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  get idle() {
    return this.active === 0 && this.waiters.length === 0;
  }
}

class BrowserScraper {
  constructor() {
    this._browser = null;
    this._launching = null;
    this._globalLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_PAGES);
    this._userLimiters = new Map();
    this._jobLimiters = new Map();
  }

  async _getBrowser() {
    if (this._browser && this._browser.isConnected()) return this._browser;
    if (this._launching) return this._launching;

    this._launching = chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    }).then((browser) => {
      this._browser = browser;
      this._launching = null;
      browser.on("disconnected", () => { this._browser = null; });
      return browser;
    });

    return this._launching;
  }

  _getScopedLimiter(map, key, limit) {
    const id = String(key);
    let limiter = map.get(id);
    if (!limiter) {
      limiter = new ConcurrencyLimiter(limit);
      map.set(id, limiter);
    }
    return { id, limiter };
  }

  _maybeCleanup(map, id, limiter) {
    if (limiter.idle) map.delete(id);
  }

  /**
   * Acquire job → user → global (specific → broad) to avoid deadlock and to
   * keep one customer's SPA sitemap from consuming every browser slot.
   * Returns opaque tokens for matching release.
   */
  async _acquireSlot({ userId, jobId } = {}) {
    const held = [];

    try {
      if (jobId != null && jobId !== "") {
        const scoped = this._getScopedLimiter(this._jobLimiters, jobId, MAX_PER_JOB);
        await scoped.limiter.acquire();
        held.push({ scope: "job", id: scoped.id, limiter: scoped.limiter });
      }

      if (userId != null && userId !== "") {
        const scoped = this._getScopedLimiter(this._userLimiters, userId, MAX_PER_USER);
        await scoped.limiter.acquire();
        held.push({ scope: "user", id: scoped.id, limiter: scoped.limiter });
      }

      await this._globalLimiter.acquire();
      held.push({ scope: "global", id: null, limiter: this._globalLimiter });

      return held;
    } catch (err) {
      this._releaseSlot(held);
      throw err;
    }
  }

  _releaseSlot(held = []) {
    for (let i = held.length - 1; i >= 0; i--) {
      const { scope, id, limiter } = held[i];
      limiter.release();
      if (scope === "job") this._maybeCleanup(this._jobLimiters, id, limiter);
      if (scope === "user") this._maybeCleanup(this._userLimiters, id, limiter);
    }
  }

  /**
   * Renders a URL with a real browser and returns fully-hydrated HTML.
   * Mirrors the shape of WebScraper.scrapeWebpage()'s return value.
   *
   * options.userId / options.jobId — used for per-tenant / per-job budgets
   * on top of the global BROWSER_SCRAPE_CONCURRENCY cap.
   */
  async scrapeWebpage(url, options = {}) {


    console.log("BrowserScraperService: scrapeWebpage", { url, options });

    console.log("fallback to the playwright browser scraper for url: ", url);
    const held = await this._acquireSlot({
      userId: options.userId,
      jobId: options.jobId,
    });
    const startTime = Date.now();
    let context;
    try {
      const browser = await this._getBrowser();

      const playwrightProxy = toPlaywrightProxy(options.proxyUrl);
      context = await browser.newContext({
        userAgent: config.userAgent,
        viewport: { width: 1280, height: 800 },
        ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
      });

      const page = await context.newPage();
      // Block heavy assets you don't need for text scraping — big speed win
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "font", "media"].includes(type)) return route.abort();
        route.continue();
      });

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.timeout || NAV_TIMEOUT_MS,
      });

      await page
        .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
        .catch(() => {});
      // Give React a moment to finish any post-load rendering/hydration
      await page.waitForTimeout(500);

      const rawHtml = await page.content();
      const statusCode = response ? response.status() : 200;

      if (statusCode === 407) {
        throw new Error(
          `Proxy authentication failed (HTTP 407). Check BROWSER proxy credentials for ${options.proxyLabel || "proxy"}.`,
        );
      }
      if (!rawHtml || !String(rawHtml).trim()) {
        throw new Error(
          `Browser render returned empty HTML (HTTP ${statusCode}) for ${url}`,
        );
      }

      return {
        rawHtml,
        statusCode,
        contentType: "text/html",
        proxy_used: options.proxyLabel || null,
        response_time: Date.now() - startTime,
        renderedWithBrowser: true,
      };
    } finally {
      if (context) await context.close();
      this._releaseSlot(held);
    }
  }

  async shutdown() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }
}

module.exports = new BrowserScraper();
