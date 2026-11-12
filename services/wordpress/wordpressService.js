const axios = require("axios");

function normalizeSiteUrl(siteUrl) {
  if (!siteUrl || typeof siteUrl !== "string") {
    throw new Error("Website URL is required");
  }
  let url = siteUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid website URL");
  }
  return parsed.origin;
}

function buildAuthHeader(username, applicationPassword) {
  const token = Buffer.from(
    `${username}:${String(applicationPassword).replace(/\s+/g, "")}`
  ).toString("base64");
  return `Basic ${token}`;
}

/**
 * Verify Application Password against WordPress REST API.
 */
async function testWordPressConnection({
  siteUrl,
  username,
  applicationPassword,
}) {
  const baseUrl = normalizeSiteUrl(siteUrl);
  const response = await axios.get(`${baseUrl}/wp-json/wp/v2/users/me`, {
    headers: {
      Authorization: buildAuthHeader(username, applicationPassword),
      Accept: "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "WordPress authentication failed. Check username and Application Password."
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `WordPress connection failed (HTTP ${response.status}). Ensure REST API is enabled and HTTPS is used.`
    );
  }

  return {
    siteUrl: baseUrl,
    userId: response.data?.id || null,
    displayName:
      response.data?.name ||
      response.data?.slug ||
      username,
  };
}

/**
 * Create a post on WordPress via REST API.
 */
async function createWordPressPost({
  siteUrl,
  username,
  applicationPassword,
  title,
  content,
  excerpt,
  status = "draft",
  tags = [],
}) {
  const baseUrl = normalizeSiteUrl(siteUrl);
  const payload = {
    title,
    content,
    excerpt: excerpt || "",
    status: status === "publish" ? "publish" : status || "draft",
  };

  // Tags as names are not supported directly; skip taxonomy assignment for v1.
  // Callers can pass tag names in excerpt/meta for now.
  void tags;

  const response = await axios.post(`${baseUrl}/wp-json/wp/v2/posts`, payload, {
    headers: {
      Authorization: buildAuthHeader(username, applicationPassword),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "WordPress authentication failed while publishing. Reconnect WordPress."
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const msg =
      response.data?.message ||
      response.data?.code ||
      `WordPress publish failed (HTTP ${response.status})`;
    throw new Error(String(msg));
  }

  return {
    postId: response.data.id,
    postUrl: response.data.link,
    status: response.data.status,
  };
}

module.exports = {
  normalizeSiteUrl,
  testWordPressConnection,
  createWordPressPost,
};
