const crypto = require("crypto");

const ENCRYPTED_PREFIX = "enc:v1:";
let warnedMissingKey = false;

function getKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        "[tokenCrypto] TOKEN_ENCRYPTION_KEY is not set; store tokens are saved unencrypted.",
      );
    }
    return null;
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a token for storage (AES-256-GCM). Returns the value unchanged when
 * it is empty or no TOKEN_ENCRYPTION_KEY is configured.
 */
function encryptToken(value) {
  if (!value) return value;
  const key = getKey();
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return (
    ENCRYPTED_PREFIX +
    [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString("base64"))
      .join(":")
  );
}

/**
 * Decrypt a stored token. Values without the encrypted prefix (saved before
 * encryption was enabled) are returned as-is.
 */
function decryptToken(value) {
  if (!value || !String(value).startsWith(ENCRYPTED_PREFIX)) return value;
  const key = getKey();
  if (!key) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt stored tokens");
  }
  const [iv, authTag, encrypted] = String(value)
    .slice(ENCRYPTED_PREFIX.length)
    .split(":")
    .map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encryptToken, decryptToken };
