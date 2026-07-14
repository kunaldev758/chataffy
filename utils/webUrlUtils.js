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

function getPathExtension(pathname) {
  const base = (pathname || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
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

function canonicalUrlKey(url) {
  const parsed = new URL(url);
  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return `${parsed.origin.toLowerCase()}${path}${parsed.search}`;
}

function normalizeWebUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  parsed.pathname = path;

  return parsed.toString();
}

function filterAndDedupeWebUrls(urls) {
  if (!Array.isArray(urls)) return [];

  const seen = new Set();
  const result = [];

  for (const raw of urls) {
    if (!isScrapableWebUrl(raw)) continue;

    const normalized = normalizeWebUrl(raw.trim());
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
  isScrapableWebUrl,
  canonicalUrlKey,
  normalizeWebUrl,
  filterAndDedupeWebUrls,
  isHtmlContentType,
  mightBeSpaShell,
  looksLikeUnrenderedSpa,
};
