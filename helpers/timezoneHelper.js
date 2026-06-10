function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function resolveTimezone(timezone, fallback = "UTC") {
  return isValidTimezone(timezone) ? timezone : fallback;
}

module.exports = {
  isValidTimezone,
  resolveTimezone,
};
