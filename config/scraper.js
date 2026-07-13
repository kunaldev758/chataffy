require("dotenv").config();

function parseProxies(rawInput) {
  const raw = String(rawInput || "")
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

function extractProxyHost(proxyUrl) {
  if (!proxyUrl) return null;
  const match = proxyUrl.match(/@([^:/]+)/);
  return match ? match[1] : null;
}

function buildRuntimeFromSettings(settings = {}) {
  const proxies = parseProxies(settings.proxies);
  return {
    proxies,
    proxyEnabled: proxies.length > 0,
    proxyTrainingOnly: settings.proxyTrainingOnly !== false,
    requestsPerProxy: Number(settings.requestsPerProxy ?? 100),
    maxRetries: Number(settings.maxRetries ?? 1),
    requestDelayMs: Number(settings.requestDelayMs ?? 100),
    discoveryDelayMs: Number(settings.discoveryDelayMs ?? 0),
    proxyFallbackDirect: settings.proxyFallbackDirect !== false,
    defaultTimeout: Number(process.env.SCRAPE_TIMEOUT_MS || 30000),
    maxContentLength: 50 * 1024 * 1024,
    userAgent:
      process.env.SCRAPE_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  };
}

function logProxyStatus(runtime) {
  if (runtime.proxies.length > 0) {
    const hosts = runtime.proxies.map(extractProxyHost).filter(Boolean);
    console.log(
      `[scraper] Proxy rotation enabled: ${runtime.proxies.length} proxy/proxies — IPs: ${hosts.join(", ")}`,
    );
    if (runtime.proxyTrainingOnly) {
      console.log(
        "[scraper] Proxy used for page training only; discovery/CSS/logo use direct connection (faster)",
      );
    }
  } else {
    console.log(
      "[scraper] Proxy rotation disabled (configure proxies in SuperAdmin → IP Proxy Setting)",
    );
  }
}

/** Mutable runtime config — updated when SuperAdmin saves settings or on DB load */
const runtime = buildRuntimeFromSettings({
  proxies: "",
  requestsPerProxy: 100,
  maxRetries: 1,
  requestDelayMs: 100,
  discoveryDelayMs: 0,
  proxyTrainingOnly: true,
  proxyFallbackDirect: true,
});

function applyRuntimeSettings(settings) {
  const next = buildRuntimeFromSettings(settings);
  Object.assign(runtime, next);
  logProxyStatus(runtime);
  return runtime;
}

module.exports = runtime;
module.exports.extractProxyHost = extractProxyHost;
module.exports.parseProxies = parseProxies;
module.exports.buildRuntimeFromSettings = buildRuntimeFromSettings;
module.exports.applyRuntimeSettings = applyRuntimeSettings;
