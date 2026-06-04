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
    password_reset_token: {
      type: String,
    },
    auth_token: {
      type: String,
    },
    sf_token: {
      type: String,
      default: '',
    },
    bc_token: {
      type: String,
      default: '',
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
    // isOnboarded: {
    //   type: Boolean,
    //   default: false,
    // },
    // handling is isOnboarded for different platforms
    isOnboarded: {
      local: { type: Boolean, default: false },
      shopify: { type: Boolean, default: false },
      bigcommerce: { type: Boolean, default: false },
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

// Generate an authentication token.
// platform: 'local' | 'shopify' | 'bigcommerce' (defaults to 'local')
userSchema.methods.generateAuthToken = function (platform = 'local') {
  const token = jwt.sign(
    {
      _id: this._id,
      email: this.email,
      role: this.role,
      platform,
    },
    process.env.JWT_SECRET_KEY,
    {
      expiresIn: "7 days",
    }
  );
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

/** Short-lived JWT for password reset links (expiry checked in resetPassword). */
userSchema.methods.generatePasswordResetToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      email: this.email,
      purpose: "password_reset",
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

// Get platform-specific onboarding status (handles object format, legacy boolean format, and defaults)
userSchema.methods.getIsOnboarded = function (platform = 'local') {
  if (this.isOnboarded && typeof this.isOnboarded === 'object') {
    return !!this.isOnboarded[platform];
  }
  if (typeof this.isOnboarded === 'boolean') {
    return this.isOnboarded;
  }
  return false;
};
const User = mongoose.model("User", userSchema);
module.exports = User;
