const NON_HTML_EXTENSIONS = new Set([
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "tiff",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "mp4",
  "mp3",
  "wav",
  "avi",
  "mov",
  "webm",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "css",
  "js",
  "mjs",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "map",
]);

const NON_HTTP_PROTOCOLS = new Set(["mailto:", "tel:", "javascript:", "data:"]);

/** Query params that create duplicate URLs without changing page content. */
const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "referrer",
]);

/**
 * Path segments / patterns that are rarely useful for RAG (cart, auth, pagination noise).
 * Matched against pathname (lowercase).
 */
const NON_CONTENT_PATH_PATTERNS = [
  /^\/cart\/?$/i,
  /^\/basket\/?$/i,
  /^\/checkout(\/|$)/i,
  /^\/login\/?$/i,
  /^\/signin\/?$/i,
  /^\/sign-in\/?$/i,
  /^\/signup\/?$/i,
  /^\/sign-up\/?$/i,
  /^\/register\/?$/i,
  /^\/account(\/|$)/i,
  /^\/my-account(\/|$)/i,
  /^\/wishlist\/?$/i,
  /^\/compare\/?$/i,
  /^\/search\/?$/i,
  /^\/cdn-cgi(\/|$)/i,
  /^\/wp-admin(\/|$)/i,
  /^\/wp-login\.php$/i,
  /^\/cart\.php$/i,
  /^\/checkout\.php$/i,
  /^\/tagged(\/|$)/i,
  /^\/tags?(\/|$)/i,
  /^\/product-tag(\/|$)/i,
  /^\/author(\/|$)/i,
  /^\/authors(\/|$)/i,
  /\/page\/\d+\/?$/i,
];

function getPathExtension(pathname) {
  const base = (pathname || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function isHomepageUrl(url) {
  if (!url || typeof url !== "string") return false;

  try {
    let path = new URL(url).pathname || "/";
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    if (path === "/" || path === "") return true;
    return /^\/index\.(html?|php|aspx)$/i.test(path);
  } catch {
    return (
      /\/$/.test(url) &&
      !url.replace(/^https?:\/\/[^/]+/, "").includes("/", 1)
    );
  }
}

function getScrapabilityRejection(url) {
  if (!url || typeof url !== "string") {
    return { reason: "empty_or_non_string_url" };
  }

  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return { reason: "unsupported_protocol" };
  }

  for (const protocol of NON_HTTP_PROTOCOLS) {
    if (trimmed.toLowerCase().startsWith(protocol)) {
      return { reason: "unsupported_protocol", protocol };
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { reason: "unsupported_protocol", protocol: parsed.protocol };
    }

    const ext = getPathExtension(parsed.pathname);
    if (ext && NON_HTML_EXTENSIONS.has(ext)) {
      return { reason: "non_html_extension", extension: ext };
    }

    return null;
  } catch (error) {
    return { reason: "invalid_url", error: error.message };
  }
}

function isScrapableWebUrl(url) {
  return getScrapabilityRejection(url) === null;
}

/** True for cart/checkout/login/etc. paths that should not enter the scrape queue. */
function isNonContentPath(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "/";
    if (NON_CONTENT_PATH_PATTERNS.some((re) => re.test(path))) return true;

    const page = parsed.searchParams.get("page");
    if (page != null && page !== "" && page !== "1") return true;

    return false;
  } catch {
    return false;
  }
}

function stripTrackingParams(parsedUrl) {
  const keys = [...parsedUrl.searchParams.keys()];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (TRACKING_QUERY_PARAMS.has(lower) || lower.startsWith("utm_")) {
      parsedUrl.searchParams.delete(key);
    }
  }
}

function canonicalUrlKey(url) {
  const parsed = new URL(url);
  stripTrackingParams(parsed);
  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const search = parsed.searchParams.toString();
  return `${parsed.origin.toLowerCase()}${path}${search ? `?${search}` : ""}`;
}

function normalizeWebUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  stripTrackingParams(parsed);

  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  parsed.pathname = path;

  return parsed.toString();
}

/** HTML + scrapable + not a non-content path. */
function isContentQueueableUrl(url) {
  if (!isScrapableWebUrl(url)) return false;
  try {
    const normalized = normalizeWebUrl(url.trim());
    return !isNonContentPath(normalized);
  } catch {
    return false;
  }
}

function filterAndDedupeWebUrls(urls, options = {}) {
  if (!Array.isArray(urls)) return [];

  const onReject =
    typeof options.onReject === "function" ? options.onReject : null;
  const seen = new Set();
  const result = [];

  for (const raw of urls) {
    const rejection = getScrapabilityRejection(raw);
    if (rejection) {
      onReject?.({ url: raw, ...rejection });
      continue;
    }

    let normalized;
    try {
      normalized = normalizeWebUrl(raw.trim());
    } catch (error) {
      onReject?.({
        url: raw,
        reason: "url_normalization_failed",
        error: error.message,
      });
      continue;
    }

    if (isNonContentPath(normalized)) {
      onReject?.({
        url: raw,
        normalizedUrl: normalized,
        reason: "non_content_path",
      });
      continue;
    }

    const key = canonicalUrlKey(normalized);
    if (seen.has(key)) {
      onReject?.({
        url: raw,
        normalizedUrl: normalized,
        reason: "duplicate_in_request",
        canonicalKey: key,
      });
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function isHtmlContentType(contentType) {
  if (!contentType || typeof contentType !== "string") return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return (
    base === "text/html" ||
    base === "application/xhtml+xml" ||
    base.startsWith("text/html")
  );
}

const SPA_ROOT_HINT_RE =
  /id\s*=\s*["']?(?:root|app|__next|__nuxt)["']?(?=[\s"'/>])|<app-root(?=[\s/>])|<main-app(?=[\s/>])/i;

function mightBeSpaShell(html) {
  if (!html || typeof html !== "string") return false;
  return SPA_ROOT_HINT_RE.test(html);
}

function looksLikeUnrenderedSpa($) {
  $("script,style,noscript").remove();

  const text = $("body").text().replace(/\s+/g, " ").trim();

  const hasRoot =
    $("#root").length ||
    $("#app").length ||
    $("#__next").length ||
    $("#__nuxt").length ||
    $("app-root").length ||
    $("main-app").length;

  const hasMeaningfulMarkup =
    $("article").length ||
    $("main").length ||
    $("h1").text().trim().length > 0;

  return hasRoot && !hasMeaningfulMarkup && text.length < 150;
}

function hostnameWithoutWww(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

/** Same registrable host, ignoring www. Used to drop McAfee/Trustwave/etc. robots sitemaps. */
function isSameSiteUrl(candidateUrl, originUrl) {
  if (!candidateUrl || !originUrl) return false;
  try {
    const candidate = new URL(candidateUrl);
    const origin =
      originUrl instanceof URL ? originUrl : new URL(String(originUrl));
    if (!["http:", "https:"].includes(candidate.protocol)) return false;
    return (
      hostnameWithoutWww(candidate.hostname) ===
      hostnameWithoutWww(origin.hostname)
    );
  } catch {
    return false;
  }
}

const WAF_TITLE_RE =
  /just a moment|attention required|checking your browser|enable javascript and cookies to continue|ddos protection by|please wait while we (?:check|verify)/i;

function htmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function visiblePageText(html) {
  const withoutNoise = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${htmlTitle(html)} ${withoutNoise}`.trim();
}

function looksLikeWafChallenge(html) {
  if (!html || typeof html !== "string") return false;
  const title = htmlTitle(html);
  if (WAF_TITLE_RE.test(title)) return true;
  const visible = visiblePageText(html);
  if (visible.length > 800) return false;
  return WAF_TITLE_RE.test(visible);
}

/** Real page content (not a short WAF interstitial) that training can use. */
function hasUsableScrapedHtml(html) {
  if (!html || typeof html !== "string") return false;
  const text = visiblePageText(html);
  const linkCount = (html.match(/<a\s/gi) || []).length;
  if (text.length >= 400 && linkCount >= 5) return true;
  if (looksLikeWafChallenge(html)) return false;
  return text.length >= 200 || linkCount >= 5;
}

function getHttpStatusFromError(err) {
  const nested = err?.response?.status;
  if (Number.isInteger(nested)) return nested;
  const msg = err?.message || "";
  const match = msg.match(/HTTP (\d{3})/);
  return match ? Number(match[1]) : null;
}

function classifyHttpStatus(status) {
  if (!Number.isInteger(status)) return "other";
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "not_found";
  if (status === 403 || status === 429) return "waf";
  if (status === 407) return "proxy_auth";
  if (status === 502 || status === 503 || status === 504) return "proxy_or_gateway";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "other";
}

function isWafHttpStatus(status) {
  return classifyHttpStatus(status) === "waf";
}

module.exports = {
  NON_HTML_EXTENSIONS,
  TRACKING_QUERY_PARAMS,
  isHomepageUrl,
  isScrapableWebUrl,
  isNonContentPath,
  isContentQueueableUrl,
  canonicalUrlKey,
  normalizeWebUrl,
  filterAndDedupeWebUrls,
  isHtmlContentType,
  mightBeSpaShell,
  looksLikeUnrenderedSpa,
  isSameSiteUrl,
  looksLikeWafChallenge,
  hasUsableScrapedHtml,
  getHttpStatusFromError,
  classifyHttpStatus,
  isWafHttpStatus,
};
