/** HttpOnly cookie used for superadmin JWT (same name as legacy localStorage key). */
const SUPERADMIN_TOKEN_COOKIE = "superAdminToken";
/**
 * Default: path where Express mounts the API (`app.use("/api", ...)` + `/superadmin` routes).
 * If the browser calls a prefixed URL (e.g. `https://host/chataffy/api/superadmin/login`),
 * set env `SUPERADMIN_COOKIE_PATH` to that public prefix (e.g. `/chataffy/api/superadmin`).
 * The cookie Path must be a prefix of the request URL path or the browser will drop Set-Cookie.
 */
const DEFAULT_SUPERADMIN_COOKIE_PATH = "/api/superadmin";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeSuperAdminCookiePath(raw) {
  const trimmed = (raw && String(raw).trim()) || DEFAULT_SUPERADMIN_COOKIE_PATH;
  let p = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  while (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p || DEFAULT_SUPERADMIN_COOKIE_PATH;
}

function getSuperAdminCookiePath() {
  return normalizeSuperAdminCookiePath(process.env.SUPERADMIN_COOKIE_PATH);
}

function getSuperAdminCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SEVEN_DAYS_MS,
    path: getSuperAdminCookiePath(),
  };
}

function getSuperAdminClearCookieOptions() {
  return {
    path: getSuperAdminCookiePath(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };
}

module.exports = {
  SUPERADMIN_TOKEN_COOKIE,
  DEFAULT_SUPERADMIN_COOKIE_PATH,
  getSuperAdminCookiePath,
  getSuperAdminCookieOptions,
  getSuperAdminClearCookieOptions,
};
