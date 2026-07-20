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

function isScrapableWebUrl(url) {
  if (!url || typeof url !== "string") return false;

  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return false;
  }

  for (const protocol of NON_HTTP_PROTOCOLS) {
    if (trimmed.toLowerCase().startsWith(protocol)) return false;
  }

  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;

    const ext = getPathExtension(parsed.pathname);
    if (ext && NON_HTML_EXTENSIONS.has(ext)) return false;

    return true;
  } catch {
    return false;
  }
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

function filterAndDedupeWebUrls(urls) {
  if (!Array.isArray(urls)) return [];

  const seen = new Set();
  const result = [];

  for (const raw of urls) {
    if (!isScrapableWebUrl(raw)) continue;

    let normalized;
    try {
      normalized = normalizeWebUrl(raw.trim());
    } catch {
      continue;
    }

    if (isNonContentPath(normalized)) continue;

    const key = canonicalUrlKey(normalized);
    if (seen.has(key)) continue;

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
};
