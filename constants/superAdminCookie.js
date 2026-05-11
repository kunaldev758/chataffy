/** HttpOnly cookie used for superadmin JWT (same name as legacy localStorage key). */
const SUPERADMIN_TOKEN_COOKIE = "superAdminToken";
/**
 * Default: public cookie path prefix for superadmin API routes.
 *
 * IMPORTANT: the cookie Path MUST be a prefix of the actual browser request path that
 * returns `Set-Cookie`, otherwise browsers will drop the cookie.
 *
 * Locally, your API is typically served at `/api/*`.
 * In production, your current public routing serves superadmin API under:
 * `/chataffy/chataffy/api/superadmin/*`.
 *
 * You can always override both via env `SUPERADMIN_COOKIE_PATH`.
 */
const LOCAL_SUPERADMIN_COOKIE_PATH = "/api/superadmin";
const PROD_SUPERADMIN_COOKIE_PATH = "/chataffy/chataffy/api/superadmin";

const DEFAULT_SUPERADMIN_COOKIE_PATH =
  process.env.NODE_ENV === "production"
    ? PROD_SUPERADMIN_COOKIE_PATH
    : LOCAL_SUPERADMIN_COOKIE_PATH;
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
