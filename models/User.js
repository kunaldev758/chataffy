const mongoose = require("mongoose");
const { Schema } = mongoose;

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: false,
    },
    email_verified: {
      type: Boolean,
      default: false,
    },
    provider: {
      type: String,
      enum: ['local', 'google', 'bigcommerce', 'shopify'],
      default: 'local',
    },
    googleId: {
      type: String,
    },
    verification_token: {
      type: String,
    },
    auth_token: {
      type: String,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ["admin", "client", "agent"],
      default: "client",
    },
    isOnboarded: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Hash the user's password before saving
userSchema.pre("save", async function (next) {
  try {
    if (!this.isModified("password")) {
      return next();
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(this.password, salt);
    this.password = hashedPassword;
    return next();
  } catch (error) {
    return next(error);
  }
});

// Generate an authentication token (optional sessionId for multi-platform sessions)
userSchema.methods.generateAuthToken = function (opts) {
  const sessionId =
    typeof opts === "string" || typeof opts === "number" ? String(opts) : opts?.sessionId;
  const platform = typeof opts === "object" ? opts?.platform : undefined;
  const storeHash = typeof opts === "object" ? opts?.storeHash : undefined;
  const shopDomain = typeof opts === "object" ? opts?.shopDomain : undefined;
  const clientId = typeof opts === "object" ? opts?.clientId : undefined;

  const payload = {
    // Backward compatible keys
    _id: this._id,
    email: this.email,
    role: this.role,

    // New explicit keys
    userId: this._id,
  };

  if (sessionId) {
    payload.sid = sessionId; // legacy
    payload.sessionId = sessionId;
  }
  if (platform) payload.platform = platform;
  if (storeHash) payload.storeHash = storeHash;
  if (shopDomain) payload.shopDomain = shopDomain;
  if (clientId) payload.clientId = clientId;

  const token = jwt.sign(payload, process.env.JWT_SECRET_KEY, {
    expiresIn: "7 days",
  });
  return token;
};

/** Short-lived JWT for email verification links (first-time verify only; expiry checked in verifyEmail). */
userSchema.methods.generateEmailVerificationToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      email: this.email,
      role: this.role,
      purpose: "email_verification",
    },
    process.env.JWT_SECRET_KEY,
    { expiresIn: "15m" }
  );
};

// Compare the user's password with a given password
userSchema.methods.comparePassword = async function (password) {
  if (!this.password) return false;
  return await bcrypt.compare(password, this.password);
};
const User = mongoose.model("User", userSchema);
module.exports = User;
