const crypto = require("crypto");

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

function resolveKey() {
  const raw =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET_KEY ||
    "";
  if (!raw) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY (or ENCRYPTION_KEY / JWT_SECRET_KEY) is required to store WordPress credentials",
    );
  }
  return crypto.createHash("sha256").update(String(raw)).digest();
}

/**
 * Encrypt a secret for Mongo storage. Returns a prefixed ciphertext string.
 */
function encryptSecret(plain) {
  const text = String(plain ?? "");
  if (!text) return text;
  if (text.startsWith(PREFIX)) return text;

  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    Buffer.concat([iv, tag, encrypted]).toString("base64url")
  );
}

/**
 * Decrypt a value produced by encryptSecret. Plaintext (legacy) values pass through.
 */
function decryptSecret(stored) {
  const text = String(stored ?? "");
  if (!text) return text;
  if (!text.startsWith(PREFIX)) return text;

  const key = resolveKey();
  const buf = Buffer.from(text.slice(PREFIX.length), "base64url");
  if (buf.length < 28) {
    throw new Error("Invalid encrypted secret payload");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

module.exports = {
  encryptSecret,
  decryptSecret,
};
