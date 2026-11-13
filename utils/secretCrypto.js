const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const raw =
    process.env.CREDENTIALS_ENCRYPTION_KEY ||
    process.env.JWT_SECRET_KEY ||
    "chataffy-dev-encryption-key";
  return crypto.createHash("sha256").update(String(raw)).digest();
}

/**
 * Encrypt a secret string for MongoDB storage.
 * Returns "iv:authTag:ciphertext" (all hex).
 */
function encryptSecret(plainText) {
  if (plainText == null || plainText === "") return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a value produced by encryptSecret.
 */
function decryptSecret(payload) {
  if (!payload) return "";
  const parts = String(payload).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
