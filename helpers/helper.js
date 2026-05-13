const nodemailer = require('nodemailer');

function getAuthCookieOptions(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const isHttpsRequest =
    req.secure || (forwardedProto && forwardedProto.includes("https"));
  const isSecureCookie =
    process.env.ENVIRONMENT === "production" || Boolean(isHttpsRequest);
  const cookieOptions = {
    httpOnly: true,
    sameSite: isSecureCookie ? "none" : "lax",
    secure: isSecureCookie,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
  if (process.env.AUTH_COOKIE_DOMAIN) {
    cookieOptions.domain = process.env.AUTH_COOKIE_DOMAIN;
  }
  return cookieOptions;
}


module.exports = { getAuthCookieOptions };
