const mongoose = require("mongoose");

/**
 * Per-Chataffy-user Wix app installation.
 * Modern Wix OAuth uses instanceId + client_credentials for access tokens.
 * Legacy custom-auth apps may also store an encrypted refreshToken.
 */
const wixConnectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    instanceId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    siteId: {
      type: String,
      default: "",
      trim: true,
    },
    siteDisplayName: {
      type: String,
      default: "",
    },
    siteUrl: {
      type: String,
      default: "",
    },
    /** Encrypted refresh token (legacy custom auth only) */
    refreshToken: {
      type: String,
      default: "",
    },
    /** Cached access token (encrypted); short-lived */
    accessToken: {
      type: String,
      default: "",
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    /** Blog author member GUID required by Blog API for 3rd-party apps */
    memberId: {
      type: String,
      default: "",
    },
    scopes: {
      type: String,
      default: "",
    },
    isConnected: {
      type: Boolean,
      default: false,
    },
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

wixConnectionSchema.index({ userId: 1 }, { unique: true });
wixConnectionSchema.index({ instanceId: 1 }, { unique: true });

module.exports = mongoose.model("WixConnection", wixConnectionSchema);
