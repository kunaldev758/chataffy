const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const config = require("../config/scraper");
const { extractProxyHost } = config;
const { isHtmlContentType, mightBeSpaShell, looksLikeUnrenderedSpa } = require("../utils/webUrlUtils");
const browserScraper = require("./BrowserScraperService");
const cheerio = require("cheerio");

function formatProxyLabel(proxySelection, proxyUrl) {
  if (!proxySelection) return "direct (no proxy)";
  const host = extractProxyHost(proxyUrl);
  return `PROXY #${proxySelection.proxyIndex + 1}${host ? ` (${host})` : ""}`;
}

const BROWSER_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  DNT: "1",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

class SequentialRotation {
  constructor(proxies, requestsPerProxy = 100) {
    this.proxies = proxies;
    this.requestsPerProxy = requestsPerProxy;
    this.currentIndex = 0;
    this.requestCount = 0;
    this.blockedProxies = new Set();
    this.proxyStats = new Map();

    this.proxies.forEach((_, idx) => {
      this.proxyStats.set(idx, { successful: 0, failed: 0, blocked: false });
    });
  }

  getNextProxy(skipCurrent = false) {
    if (skipCurrent || this.requestCount >= this.requestsPerProxy) {
      const oldIndex = this.currentIndex;
      this.currentIndex = this.findNextAvailableProxy(
        skipCurrent ? (this.currentIndex + 1) % this.proxies.length : undefined,
      );
      if (oldIndex !== this.currentIndex || skipCurrent) {
        const host = extractProxyHost(this.proxies[this.currentIndex]);
        console.log(
          `[WebScraper] Rotated to PROXY #${this.currentIndex + 1}${host ? ` (${host})` : ""}`,
        );
      }
      this.requestCount = 0;
    }

    this.requestCount++;
    return {
      proxy: this.proxies[this.currentIndex],
      proxyIndex: this.currentIndex,
    };
  }

  findNextAvailableProxy(startIndex) {
    if (this.proxies.length === 0) return 0;

    let nextIndex =
      startIndex !== undefined
        ? startIndex
        : (this.currentIndex + 1) % this.proxies.length;
    let attempts = 0;

    while (
      this.blockedProxies.has(nextIndex) &&
      attempts < this.proxies.length
    ) {
      nextIndex = (nextIndex + 1) % this.proxies.length;
      attempts++;
    }

    if (attempts >= this.proxies.length) {
      console.warn("[WebScraper] All proxies blocked — resetting blocked list");
      this.blockedProxies.clear();
      this.proxyStats.forEach((stats) => {
        stats.blocked = false;
      });
      return 0;
    }

    return nextIndex;
  }

  markProxyAsBlocked(proxyIndex) {
    this.blockedProxies.add(proxyIndex);
    const stats = this.proxyStats.get(proxyIndex);
    if (stats) stats.blocked = true;
    const host = extractProxyHost(this.proxies[proxyIndex]);
    console.warn(
      `[WebScraper] PROXY #${proxyIndex + 1}${host ? ` (${host})` : ""} marked as blocked (${this.blockedProxies.size}/${this.proxies.length} blocked)`,
    );
  }

  recordSuccess(proxyIndex) {
    const stats = this.proxyStats.get(proxyIndex);
    if (stats) stats.successful++;
  }

  recordFailure(proxyIndex) {
    const stats = this.proxyStats.get(proxyIndex);
    if (stats) stats.failed++;
  }
}

class WebScraper {
  constructor() {
    this._agentCache = new Map();
    this._lastTrainingRequestAt = 0;
    this._lastDiscoveryRequestAt = 0;
    /** Lock only proxy rotation + proxied training requests (not direct discovery) */
    this._proxyLock = Promise.resolve();
    this.reloadConfig();
  }

  /** Rebuild proxy rotation after SuperAdmin saves IP proxy settings */
  reloadConfig() {
    this._agentCache.clear();
    this.rotationHandler = config.proxyEnabled
      ? new SequentialRotation(config.proxies, config.requestsPerProxy)
      : null;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async withProxyLock(fn) {
    const prev = this._proxyLock;
    let release;
    this._proxyLock = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async throttle(kind = "training") {
    const delayMs =
      kind === "discovery" ? config.discoveryDelayMs : config.requestDelayMs;
    if (!delayMs) return;

    const lastAt =
      kind === "discovery"
        ? this._lastDiscoveryRequestAt
        : this._lastTrainingRequestAt;
    const elapsed = Date.now() - lastAt;
    if (elapsed < delayMs) {
      await this.sleep(delayMs - elapsed);
    }
    if (kind === "discovery") {
      this._lastDiscoveryRequestAt = Date.now();
    } else {
      this._lastTrainingRequestAt = Date.now();
    }
  }

  getCachedAgents(proxyUrl) {
    if (!proxyUrl) return {};
    if (!this._agentCache.has(proxyUrl)) {
      this._agentCache.set(proxyUrl, {
        httpsAgent: new HttpsProxyAgent(proxyUrl),
        httpAgent: new HttpProxyAgent(proxyUrl),
      });
    }
    const cached = this._agentCache.get(proxyUrl);
    return {
      httpsAgent: cached.httpsAgent,
      httpAgent: cached.httpAgent,
      proxy: false,
    };
  }

  buildRequestConfig(url, options = {}, proxyUrl = null) {
    const timeout = options.timeout ?? config.defaultTimeout;
    const headers = {
      "User-Agent": config.userAgent,
      ...(options.useBrowserHeaders !== false ? BROWSER_HEADERS : {}),
      ...options.headers,
    };

    return {
      timeout,
      responseType: options.responseType || "text",
      maxContentLength: options.maxContentLength ?? config.maxContentLength,
      validateStatus:
        options.validateStatus || ((status) => status >= 200 && status < 300),
      headers,
      ...this.getCachedAgents(proxyUrl),
    };
  }

  isBlockedError(err) {
    const msg = err?.message || "";
    return (
      msg.includes("407") ||
      msg.includes("403") ||
      msg.includes("429") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNRESET")
    );
  }

  isRetryableHttpStatus(status) {
    return status === 407 || status === 403 || status === 429 || status >= 400;
  }

  assertAcceptableResponse(response, url) {
    if (response.status === 407) {
      throw new Error(
        "HTTP 407: Proxy authentication required (check IP Proxy Setting credentials)",
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `HTTP ${response.status}: Likely blocked or rate limited`,
      );
    }
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
  }

  async performRequest(url, options = {}, proxyUrl = null, throttleKind = "training") {
    await this.throttle(throttleKind);
    const requestConfig = this.buildRequestConfig(url, options, proxyUrl);
    let response = await axios.get(url, requestConfig);

    if (response.status === 304 && options.responseType !== "arraybuffer") {
      const cacheBustUrl = url.includes("?")
        ? `${url}&_t=${Date.now()}`
        : `${url}?_t=${Date.now()}`;
      const retryConfig = this.buildRequestConfig(
        cacheBustUrl,
        {
          ...options,
          headers: {
            ...options.headers,
            "If-None-Match": "",
            "If-Modified-Since": "",
          },
        },
        proxyUrl,
      );
      const retryResponse = await axios.get(cacheBustUrl, retryConfig);
      if (
        retryResponse.status !== 304 &&
        retryResponse.data &&
        (typeof retryResponse.data !== "string" ||
          retryResponse.data.trim().length > 0)
      ) {
        response = retryResponse;
      }
    }

    return response;
  }

  shouldUseProxyForFetch(options = {}) {
    if (options.useProxy === true) return true;
    if (options.useProxy === false) return false;
    if (config.proxyTrainingOnly) return false;
    return config.proxyEnabled;
  }

  /**
   * Discovery, sitemap, CSS, logo — direct by default (fast, parallel-safe).
   * Set options.useProxy=true or proxyTrainingOnly=false in SuperAdmin to proxy these too.
   */
  async fetchUrl(url, options = {}) {
    const useProxy = this.shouldUseProxyForFetch(options);

    if (!useProxy) {
      const response = await this.performRequest(
        url,
        options,
        null,
        "discovery",
      );
      if (this.isRetryableHttpStatus(response.status)) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response;
    }

    const maxRetries = options.maxRetries ?? config.maxRetries;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proxySelection = this.rotationHandler.getNextProxy(attempt > 0);
      const proxyUrl = proxySelection.proxy;
      const proxyLabel = formatProxyLabel(proxySelection, proxyUrl);

      try {
        const response = await this.withProxyLock(() =>
          this.performRequest(url, options, proxyUrl, "discovery"),
        );

        if (this.isRetryableHttpStatus(response.status)) {
          throw new Error(`HTTP ${response.status} for ${url}`);
        }

        this.rotationHandler.recordSuccess(proxySelection.proxyIndex);
        console.log(
          `[WebScraper] fetch OK | ${proxyLabel} | HTTP ${response.status} | ${url}`,
        );
        return response;
      } catch (err) {
        lastError = err;
        console.warn(
          `[WebScraper] fetch FAIL | ${proxyLabel} | attempt ${attempt + 1}/${maxRetries + 1} | ${url} | ${err.message}`,
        );
        this.rotationHandler.recordFailure(proxySelection.proxyIndex);
        if (this.isBlockedError(err)) {
          this.rotationHandler.markProxyAsBlocked(proxySelection.proxyIndex);
        }
        if (attempt === maxRetries) break;
        await this.sleep(1000 * (attempt + 1));
      }
    }

    if (config.proxyFallbackDirect) {
      console.log(`[WebScraper] fetch fallback direct (no proxy) | ${url}`);
      const response = await this.performRequest(
        url,
        options,
        null,
        "discovery",
      );
      if (!this.isRetryableHttpStatus(response.status)) {
        console.log(
          `[WebScraper] fetch OK | direct (no proxy) | HTTP ${response.status} | ${url}`,
        );
        return response;
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    throw lastError || new Error(`Failed to fetch ${url}`);
  }

  // If the page is a SPA shell, rendering it with the browser
  async maybeRenderSpaWithBrowser(result, url, options, proxyUrl, proxyLabel) {
    if (!mightBeSpaShell(result.rawHtml)) return result;

    const $ = cheerio.load(result.rawHtml);
    if (!looksLikeUnrenderedSpa($)) return result;

    console.log(`[WebScraper] Detected unrendered SPA shell, retrying with browser | ${url}`);
    try {
      return await browserScraper.scrapeWebpage(url, {
        proxyUrl,
        proxyLabel,
        userId: options.userId,
        jobId: options.jobId,
        timeout: options.timeout,
      });
    } catch (browserErr) {
      console.warn(`[WebScraper] Browser fallback failed, keeping thin HTML | ${url} | ${browserErr.message}`);
      return result;
    }
  }

  /**
   * Page training — uses proxy rotation when proxies are configured in SuperAdmin.
   */
  async scrapeWebpage(url, options = {}) {
    const maxRetries = options.maxRetries ?? config.maxRetries;
    const timeout = options.timeout ?? config.defaultTimeout;
    let lastError = null;

    const runScrape = async (proxyUrl, proxySelection) => {
      const startTime = Date.now();
      const proxyLabel = formatProxyLabel(proxySelection, proxyUrl);

      const doRequest = () =>
        this.performRequest(
          url,
          {
            timeout,
            maxContentLength: config.maxContentLength,
            validateStatus: (status) => status < 500,
            useBrowserHeaders: true,
          },
          proxyUrl,
          "training",
        );

      const response = proxyUrl
        ? await this.withProxyLock(doRequest)
        : await doRequest();

      this.assertAcceptableResponse(response, url);

      if (
        typeof response.data !== "string" ||
        response.data.trim().length === 0
      ) {
        throw new Error(
          `Empty response body received. Status: ${response.status}`,
        );
      }

      const contentType = response.headers?.["content-type"] || "";
      if (contentType && !isHtmlContentType(contentType)) {
        throw new Error(
          `Non-HTML content type: ${contentType || "unknown"}`,
        );
      }

      const responseTime = Date.now() - startTime;

      if (proxySelection) {
        this.rotationHandler.recordSuccess(proxySelection.proxyIndex);
      }

      console.log(
        `[WebScraper] scrape OK | ${proxyLabel} | ${responseTime}ms | HTTP ${response.status} | ${url}`,
      );

      return {
        rawHtml: response.data,
        statusCode: response.status,
        contentType,
        proxy_used: proxySelection ? proxySelection.proxyIndex + 1 : null,
        proxy_ip: extractProxyHost(proxyUrl),
        response_time: responseTime,
      };
    };

    if (!config.proxyEnabled) {
      const result = await runScrape(null, null);
      return this.maybeRenderSpaWithBrowser(result, url, options, null, null);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proxySelection = this.rotationHandler.getNextProxy(attempt > 0);
      const proxyUrl = proxySelection.proxy;
      const proxyLabel = formatProxyLabel(proxySelection, proxyUrl);

      try {
        const result = await runScrape(proxyUrl, proxySelection);
        return await this.maybeRenderSpaWithBrowser(result, url, options, proxyUrl, proxyLabel);
      } catch (err) {
        lastError = err;
        console.warn(
          `[WebScraper] scrape FAIL | ${proxyLabel} | attempt ${attempt + 1}/${maxRetries + 1} | ${url} | ${err.message}`,
        );
        this.rotationHandler.recordFailure(proxySelection.proxyIndex);
        if (this.isBlockedError(err)) {
          this.rotationHandler.markProxyAsBlocked(proxySelection.proxyIndex);
        }
        if (attempt === maxRetries) break;
        await this.sleep(1000 * (attempt + 1));
      }
    }

    if (config.proxyFallbackDirect) {
      try {
        console.log(`[WebScraper] scrape fallback direct (no proxy) | ${url}`);
        const result = await runScrape(null, null);
        return await this.maybeRenderSpaWithBrowser(result, url, options, null, null);
      } catch (directErr) {
        lastError = directErr;
      }
    }

    throw new Error(
      `Scraping failed after ${maxRetries + 1} attempts: ${lastError?.message || "unknown error"}`,
    );
  }
}

const webScraper = new WebScraper();

module.exports = webScraper;
module.exports.WebScraper = WebScraper;
