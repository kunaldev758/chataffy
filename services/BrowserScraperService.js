const { chromium } = require("playwright");
const config = require("../config/scraper");
const { looksLikeWafChallenge, hasUsableScrapedHtml } = require("../utils/webUrlUtils");

const MAX_CONCURRENT_PAGES = parseInt(process.env.BROWSER_SCRAPE_CONCURRENCY || "2", 10);
const MAX_PER_USER = parseInt(process.env.BROWSER_SCRAPE_PER_USER || "1", 10);
const MAX_PER_JOB = parseInt(process.env.BROWSER_SCRAPE_PER_JOB || "1", 10);
const NAV_TIMEOUT_MS = 45000;
const WAF_WAIT_MS = parseInt(process.env.BROWSER_SCRAPE_WAF_WAIT_MS || "25000", 10);
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

    const launchOptions = {
      headless: true,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
    };

    this._launching = chromium
      .launch({ ...launchOptions, channel: "chrome" })
      .catch(() => chromium.launch(launchOptions))
      .then((browser) => {
        this._browser = browser;
        this._launching = null;
        browser.on("disconnected", () => { this._browser = null; });
        return browser;
      })
      .catch((err) => {
        this._launching = null;
        throw err;
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
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
        },
        ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });
      });

      const navTimeout = Math.max(options.timeout || NAV_TIMEOUT_MS, NAV_TIMEOUT_MS);
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: navTimeout,
      });

      await page
        .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
        .catch(() => {});
      await page.waitForTimeout(800);

      let rawHtml = await page.content();
      if (looksLikeWafChallenge(rawHtml) && !hasUsableScrapedHtml(rawHtml)) {
        console.log(`[BrowserScraper] WAF challenge detected, waiting | ${url}`);
        const deadline = Date.now() + WAF_WAIT_MS;
        while (Date.now() < deadline) {
          await page.waitForTimeout(1500);
          rawHtml = await page.content();
          if (!looksLikeWafChallenge(rawHtml) || hasUsableScrapedHtml(rawHtml)) {
            console.log(`[BrowserScraper] WAF challenge cleared | ${url}`);
            break;
          }
        }
      }

      let statusCode = response ? response.status() : 200;

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
      if (hasUsableScrapedHtml(rawHtml) && (statusCode === 403 || statusCode === 429 || statusCode === 503)) {
        statusCode = 200;
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
