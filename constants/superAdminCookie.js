/** HttpOnly cookie used for superadmin JWT (same name as legacy localStorage key). */
const SUPERADMIN_TOKEN_COOKIE = "superAdminToken";
/** Limit cookie to superadmin API routes so it is not sent on unrelated paths/ports’ requests where possible. */
const SUPERADMIN_COOKIE_PATH = "/api/superadmin";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getSuperAdminCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SEVEN_DAYS_MS,
    path: SUPERADMIN_COOKIE_PATH,
  };
}

function getSuperAdminClearCookieOptions() {
  return {
    path: SUPERADMIN_COOKIE_PATH,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };
}

module.exports = {
  SUPERADMIN_TOKEN_COOKIE,
  getSuperAdminCookieOptions,
  getSuperAdminClearCookieOptions,
};
