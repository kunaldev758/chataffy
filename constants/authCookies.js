const { getAuthCookieOptions } = require("../helpers/helper");

const CLIENT_TOKEN = "CLIENT_TOKEN";
const AGENT_TOKEN = "AGENT_TOKEN";
const LEGACY_TOKEN = "token";

function clearCookieOpts(req) {
  const base = getAuthCookieOptions(req);
  return { ...base, maxAge: 0 };
}

function setClientSessionCookies(res, req, token) {
  const opts = getAuthCookieOptions(req);
  res.cookie(CLIENT_TOKEN, token, opts);
  res.cookie("platform", "local", opts);
}

function setAgentSessionCookies(res, req, token) {
  const opts = getAuthCookieOptions(req);
  res.cookie(AGENT_TOKEN, token, opts);
}

function clearClientSessionCookies(res, req) {
  const opts = clearCookieOpts(req);
  res.clearCookie(CLIENT_TOKEN, opts);
  res.clearCookie(LEGACY_TOKEN, opts);
  res.clearCookie("role", opts);
}

function clearAgentSessionCookies(res, req) {
  const opts = clearCookieOpts(req);
  res.clearCookie(AGENT_TOKEN, opts);
  res.clearCookie("role", opts);
}

/** Ordered candidates for JWT auth (Shopify/BC first, then dual local tokens). */
function collectAuthTokenCandidates(req) {
  const list = [];
  const rawAuth = req.header("Authorization");
  if (rawAuth) {
    const t = rawAuth.replace(/^Bearer\s+/i, "").trim();
    if (t) list.push({ name: "authorization", token: t });
  }

  const platform = req.cookies?.platform || "local";
  if (platform === "shopify" && req.cookies?.sf_token) {
    list.push({ name: "sf_token", token: req.cookies.sf_token });
  }
  if (platform === "bigcommerce" && req.cookies?.bc_token) {
    list.push({ name: "bc_token", token: req.cookies.bc_token });
  }
  if (req.cookies?.[CLIENT_TOKEN]) {
    list.push({ name: CLIENT_TOKEN, token: req.cookies[CLIENT_TOKEN] });
  }
  if (req.cookies?.[AGENT_TOKEN]) {
    list.push({ name: AGENT_TOKEN, token: req.cookies[AGENT_TOKEN] });
  }
  if (req.cookies?.[LEGACY_TOKEN]) {
    list.push({ name: LEGACY_TOKEN, token: req.cookies[LEGACY_TOKEN] });
  }

  return list;
}

module.exports = {
  CLIENT_TOKEN,
  AGENT_TOKEN,
  LEGACY_TOKEN,
  setClientSessionCookies,
  setAgentSessionCookies,
  clearClientSessionCookies,
  clearAgentSessionCookies,
  collectAuthTokenCandidates,
};
