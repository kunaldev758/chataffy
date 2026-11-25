const crypto = require("crypto");

function getCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }
  return { keyId, keySecret };
}

function assertConfigured() {
  const credentials = getCredentials();
  if (!credentials) {
    const error = new Error(
      "Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the backend .env file."
    );
    error.statusCode = 503;
    throw error;
  }
  return credentials;
}

function getClient() {
  const { keyId, keySecret } = assertConfigured();
  const Razorpay = require("razorpay");
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function toPaise(amountInr) {
  return Math.round(Number(amountInr) * 100);
}

/**
 * Razorpay India charges in INR (paise).
 * - Plan currency INR: use the listed monthly/yearly price.
 * - Plan currency USD: convert with RAZORPAY_USD_TO_INR (you set the rate).
 */
function resolveInrCharge(plan, billingCycle) {
  const pricing = plan?.pricing || {};
  const cycle = billingCycle === "yearly" ? "yearly" : "monthly";
  const listed = Number(cycle === "yearly" ? pricing.yearly : pricing.monthly);
  const currency = String(pricing.currency || "USD").toUpperCase();

  if (!Number.isFinite(listed) || listed <= 0) {
    return { error: "This plan does not require a payment." };
  }

  if (currency === "INR") {
    const amountInr = roundMoney(listed);
    return {
      amountInr,
      amountPaise: toPaise(amountInr),
      amountUsd: null,
      fxRate: null,
      listedAmount: listed,
      listedCurrency: "INR",
    };
  }

  if (currency !== "USD") {
    return {
      error: `Razorpay checkout supports INR. This plan is priced in ${currency}. Set the plan currency to INR or USD.`,
    };
  }

  const rate = Number(process.env.RAZORPAY_USD_TO_INR);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      error:
        "Razorpay charges in INR. Set the plan currency to INR, or set RAZORPAY_USD_TO_INR in the backend .env to convert this USD price.",
    };
  }

  const amountInr = roundMoney(listed * rate);
  return {
    amountInr,
    amountPaise: toPaise(amountInr),
    amountUsd: roundMoney(listed),
    fxRate: rate,
    listedAmount: listed,
    listedCurrency: "USD",
  };
}

function safeEqualHex(expectedHex, receivedHex) {
  const expected = Buffer.from(String(expectedHex || ""), "utf8");
  const received = Buffer.from(String(receivedHex || ""), "utf8");
  if (expected.length === 0 || expected.length !== received.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, received);
}

function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const { keySecret } = assertConfigured();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqualHex(expected, signature);
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) {
    return false;
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return safeEqualHex(expected, signature);
}

module.exports = {
  assertConfigured,
  getClient,
  resolveInrCharge,
  toPaise,
  verifyCheckoutSignature,
  verifyWebhookSignature,
};
