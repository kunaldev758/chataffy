const fs = require("fs");
// Function to store error logs in a file
function logErrorToFile(error) {
  const logFilePath = "error.log";
  const logMessage = `${new Date().toISOString()} - ${error.stack}\n`;

  fs.appendFile(logFilePath, logMessage, (err) => {
    if (err) {
      console.error("Error writing to log file:", err);
    }
  });
}

/** Hostname from a URL or bare domain string (e.g. https://www.foo.com/bar → foo.com). */
function hostnameFromUrlLike(input) {
  if (!input || typeof input !== "string") return "";
  const s = input.trim();
  if (!s) return "";
  try {
    const url = s.includes("://") ? new URL(s) : new URL(`https://${s.replace(/^\/\//, "")}`);
    const h = (url.hostname || "").replace(/^www\./i, "");
    return h || "";
  } catch {
    return "";
  }
}

/**
 * Site "name" without TLD: seokart.com → seokart, www.foo.co.uk → foo.
 */
function primaryHostnameLabel(hostname) {
  if (!hostname || typeof hostname !== "string") return "";
  const parts = hostname.trim().split(".").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];

  const lower = parts.map((p) => p.toLowerCase());
  const multiSuffixes = [
    ["co", "uk"],
    ["com", "au"],
    ["co", "nz"],
    ["co", "jp"],
    ["com", "br"],
    ["co", "in"],
    ["net", "au"],
    ["org", "uk"],
    ["ac", "uk"],
    ["gov", "uk"],
  ];
  const lastTwo = lower.slice(-2);
  for (const suf of multiSuffixes) {
    if (lastTwo[0] === suf[0] && lastTwo[1] === suf[1] && parts.length >= 3) {
      return parts[parts.length - 3];
    }
  }
  if (parts.length === 2) {
    return parts[0];
  }
  return parts[parts.length - 2];
}

function looksLikeHostnameOrDomain(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  if (!t.includes(".")) return false;
  return /^[\w.-]+\.[\w.-]+$/i.test(t);
}

/**
 * Label for client HumanAgent (isClient): prefer website domain, then onboarding URL, then agentName.
 * Drops TLD (.com, .co.uk, …) so the display name is e.g. "seokart" not "seokart.com".
 */
function clientHumanAgentNameFromAgent(agent) {
  if (!agent) return "client";
  const websiteName = (agent.website_name || "").trim();
  const agentName = (agent.agentName || "").trim();
  const onboardingUrl = (agent.onboardingWebsiteUrl || "").trim();

  const host =
    hostnameFromUrlLike(websiteName) ||
    hostnameFromUrlLike(onboardingUrl) ||
    hostnameFromUrlLike(agentName);

  if (host) {
    const label = primaryHostnameLabel(host);
    if (label) return label;
  }

  const fallback = agentName || websiteName;
  if (!fallback) return "client";
  if (looksLikeHostnameOrDomain(fallback)) {
    const h = hostnameFromUrlLike(fallback);
    if (h) {
      const label = primaryHostnameLabel(h);
      if (label) return label;
    }
  }
  return fallback;
}

module.exports = { logErrorToFile, clientHumanAgentNameFromAgent };
