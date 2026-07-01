require("dotenv").config();

function loadProxies() {
  // Collapse accidental line breaks / spaces around commas in .env
  const raw = (process.env.SCRAPE_PROXIES || "")
    .replace(/\r?\n/g, ",")
    .replace(/\s*,\s*/g, ",");
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":");
      if (parts.length < 4) {
        console.warn(
          `[scraper] Invalid proxy entry (expected host:port:user:pass): ${entry}`,
        );
        return null;
      }
      const pass = parts.slice(3).join(":");
      const [host, port, user] = parts;
      return `http://${user}:${pass}@${host}:${port}`;
    })
    .filter(Boolean);
}

const proxies = loadProxies();

function extractProxyHost(proxyUrl) {
  if (!proxyUrl) return null;
  const match = proxyUrl.match(/@([^:/]+)/);
  return match ? match[1] : null;
}

if (proxies.length > 0) {
  const hosts = proxies.map(extractProxyHost).filter(Boolean);
  console.log(
    `[scraper] Proxy rotation enabled: ${proxies.length} proxy/proxies — IPs: ${hosts.join(", ")}`,
  );
} else {
  console.log(
    "[scraper] Proxy rotation disabled (set SCRAPE_PROXIES in .env to enable)",
  );
}

module.exports = {
  extractProxyHost,
  proxies,
  proxyEnabled: proxies.length > 0,
  requestsPerProxy: Number(process.env.SCRAPE_REQUESTS_PER_PROXY || 100),
  maxRetries: Number(process.env.SCRAPE_MAX_RETRIES || 2),
  requestDelayMs: Number(process.env.SCRAPE_REQUEST_DELAY_MS || 300),
  /** When true, retry without proxy after all proxy attempts fail */
  proxyFallbackDirect: process.env.SCRAPE_PROXY_FALLBACK_DIRECT !== "false",
  defaultTimeout: Number(process.env.SCRAPE_TIMEOUT_MS || 30000),
  maxContentLength: 50 * 1024 * 1024,
  userAgent:
    process.env.SCRAPE_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
};
