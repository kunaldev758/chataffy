const MONEY_FORMAT_GLYPH = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  AUD: "$",
  CAD: "$",
  KRW: "₩",
  ILS: "₪",
  THB: "฿",
  VND: "₫",
  PHP: "₱",
};

/** Canonicalize an explicit token (ISO, Rs., or glyph). No whole-string sniffing. */
function normalizeCurrencyToken(text = "") {
  const str = String(text || "").trim();
  if (!str) return "";
  if (/^[A-Za-z]{3}$/.test(str)) return str.toUpperCase();
  if (str === "₹" || /^Rs\.?$/i.test(str)) return "INR";
  if (str === "€") return "EUR";
  if (str === "£") return "GBP";
  if (str === "$") return "$";
  if (str === "¥") return "¥";
  if (str === "₩") return "KRW";
  if (str === "₪") return "ILS";
  if (str === "฿") return "THB";
  if (str === "₫") return "VND";
  if (str === "₱") return "PHP";
  return "";
}

function parseShopifyCurrency(html = "") {
  if (!html) return { active: "", rate: null };
  const m = String(html).match(/Shopify\.currency\s*=\s*\{([^}]{0,400})\}/);
  if (!m) return { active: "", rate: null };
  const body = m[1];
  const activeM = body.match(/["']active["']\s*:\s*["']([A-Za-z]{3})["']/);
  const active = activeM ? activeM[1].toUpperCase() : "";
  const rateM = body.match(/["']rate["']\s*:\s*["']?([0-9]*\.?[0-9]+)["']?/);
  let rate = null;
  if (rateM) {
    const n = Number(rateM[1]);
    if (Number.isFinite(n)) rate = n;
  }
  return { active, rate };
}

function shopifyRateIsUnity(rate) {
  return rate != null && Number.isFinite(rate) && Math.abs(rate - 1) < 1e-6;
}

/**
 * Shop (catalog) currency — not presentment `active`.
 * Skips Rs/₹ money formats so India HTML does not label USD JSON as INR.
 */
function parseShopifyShopCurrency(html = "") {
  const raw = String(html || "");
  if (!raw) return "";
  const named = raw.match(
    /(?:shopCurrency|shop_currency)\s*[:=]\s*["']([A-Za-z]{3})["']/i,
  );
  if (named) return normalizeCurrencyToken(named[1]);
  const shopBlock = raw.match(
    /"shop"\s*:\s*\{[^}]{0,500}?"(?:currencyCode|currency|isoCode)"\s*:\s*"([A-Za-z]{3})"/i,
  );
  if (shopBlock) return normalizeCurrencyToken(shopBlock[1]);
  const fmtRe =
    /(?:Shopify\.money_format|money_format|moneyFormat)\s*[:=]\s*"((?:\\.|[^"\\]){0,80})"/gi;
  let fm;
  while ((fm = fmtRe.exec(raw)) !== null) {
    const fmt = fm[1].replace(/\\u0024/g, "$");
    if (/₹|Rs\.?/i.test(fmt)) continue;
    if (/\$/.test(fmt)) return "$";
    if (/€/.test(fmt)) return "EUR";
    if (/£/.test(fmt)) return "GBP";
  }
  return "";
}

/** ISO when rate is 1 or omitted; empty when rate is a FX conversion. */
function extractShopifyCurrencyActive(html = "") {
  const { active, rate } = parseShopifyCurrency(html);
  if (!active) return "";
  if (rate != null && !shopifyRateIsUnity(rate)) return "";
  return active;
}

function moneyAmountsMatch(a, b) {
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.009;
}

function formatMoneyAmount(amount, currency) {
  if (amount == null) return null;
  let cur = currency ? String(currency).trim() : "";
  const mapped = cur ? MONEY_FORMAT_GLYPH[cur.toUpperCase()] : "";
  if (mapped) cur = mapped;
  if (/^[$€£₹¥₩₪฿₫₱]/.test(cur)) return `${cur}${amount}`;
  if (cur) return `${amount} ${cur}`;
  return String(amount);
}

/** Stamp shop/presentment currency only when the row has none. */
function applyShopifyCurrencyToAttrs(html, attrs = {}) {
  if (!attrs || attrs.currency) return attrs;
  const { active, rate } = parseShopifyCurrency(html);
  if (active && (rate == null || shopifyRateIsUnity(rate))) {
    attrs.currency = active;
    return attrs;
  }
  if (rate != null && !shopifyRateIsUnity(rate)) {
    const shopCur = parseShopifyShopCurrency(html);
    if (shopCur) attrs.currency = shopCur;
  }
  return attrs;
}

/**
 * Attach currency from DOM/LD only when amounts match the kept price.
 * Otherwise use Shopify.currency / shop money_format — never ₹ on 8.99.
 * `sources` is tried in order (DOM first, then JSON-LD).
 */
function reconcileProductCurrency(html, attrs = {}, sources = []) {
  if (!attrs || typeof attrs !== "object") return attrs;
  const price = attrs.price;
  let currency = "";
  for (const src of sources) {
    if (!src || !src.currency) continue;
    if (price == null || moneyAmountsMatch(price, src.price)) {
      currency = src.currency;
      break;
    }
  }
  if (currency) attrs.currency = currency;
  else delete attrs.currency;

  // LD/DOM rupees must not become compare-at on unlocalized USD JSON (577 vs 5.99).
  if (
    attrs.original_price != null &&
    attrs.price != null &&
    Number(attrs.original_price) > Number(attrs.price) * 8
  ) {
    delete attrs.original_price;
  }

  if (attrs.currency) return attrs;
  return applyShopifyCurrencyToAttrs(html, attrs);
}

module.exports = {
  MONEY_FORMAT_GLYPH,
  normalizeCurrencyToken,
  parseShopifyCurrency,
  shopifyRateIsUnity,
  parseShopifyShopCurrency,
  extractShopifyCurrencyActive,
  moneyAmountsMatch,
  formatMoneyAmount,
  applyShopifyCurrencyToAttrs,
  reconcileProductCurrency,
};
