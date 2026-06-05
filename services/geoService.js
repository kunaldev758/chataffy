const geoCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function getIpinfoToken() {
  if (process.env.IPINFO_TOKEN) return process.env.IPINFO_TOKEN;
  const url = process.env.IPINFO_URL || "";
  const match = url.match(/token=([^&]+)/);
  return match?.[1] || null;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

function getClientIpFromSocket(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded) {
    const ip = String(forwarded).split(",")[0].trim();
    if (ip) return ip;
  }

  const realIp = socket.handshake.headers["x-real-ip"];
  if (realIp) return String(realIp).trim();

  const addr = socket.handshake.address;
  if (addr) return String(addr).replace(/^::ffff:/, "");

  return null;
}

function getClientIpFromHeaders(headerMap) {
  const forwarded = headerMap.get?.("x-forwarded-for") || headerMap["x-forwarded-for"];
  if (forwarded) {
    const ip = String(forwarded).split(",")[0].trim();
    if (ip) return ip;
  }

  const realIp = headerMap.get?.("x-real-ip") || headerMap["x-real-ip"];
  if (realIp) return String(realIp).trim();

  const cfIp = headerMap.get?.("cf-connecting-ip") || headerMap["cf-connecting-ip"];
  if (cfIp) return String(cfIp).trim();

  return null;
}

function buildIpinfoUrl(ip) {
  const token = getIpinfoToken();
  if (!token || !ip) return null;
  return `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${token}`;
}

async function lookupGeoByIp(ip) {
  if (!ip || isPrivateIp(ip)) {
    return { ip, country: "UNKNOWN" };
  }

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = buildIpinfoUrl(ip);
  if (!url) {
    return { ip, country: "UNKNOWN" };
  }

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      console.error("ipinfo lookup failed:", response.status, ip);
      return { ip, country: "UNKNOWN" };
    }

    const data = await response.json();
    const result = {
      ip: data.ip || ip,
      country: data.country || "UNKNOWN",
    };
    geoCache.set(ip, { ts: Date.now(), data: result });
    return result;
  } catch (error) {
    console.error("ipinfo lookup error:", error.message);
    return { ip, country: "UNKNOWN" };
  }
}

async function resolveVisitorGeoForSocket(socket) {
  if (socket._visitorGeo) return socket._visitorGeo;

  const ip = getClientIpFromSocket(socket);
  const geo = await lookupGeoByIp(ip);
  socket._visitorGeo = {
    ip: geo.ip || ip,
    country: geo.country || "UNKNOWN",
  };
  return socket._visitorGeo;
}

module.exports = {
  getClientIpFromSocket,
  getClientIpFromHeaders,
  lookupGeoByIp,
  resolveVisitorGeoForSocket,
  isPrivateIp,
};
