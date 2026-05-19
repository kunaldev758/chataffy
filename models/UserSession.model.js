const mongoose = require("mongoose");

const UserSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /**
     * Unique session id (JWT `sid` claim)
     */
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },

    platform: {
      type: String,
      enum: ["shopify", "bigcommerce", "web"],
      required: true,
    },

    /**
     * Store/client isolation (sanitized id string)
     */
    clientId: {
      type: String,
      required: true,
    },

    tokenHash: {
      type: String,
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: {
        expires:0,
      },
    },
  },
  {
    timestamps: true,
  },
);

// Multiple concurrent sessions per user/platform/client allowed (no unique constraint)
UserSessionSchema.index({ userId: 1, platform: 1, clientId: 1 });
UserSessionSchema.index({ userId: 1, isActive: 1 });
UserSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const UserSession = mongoose.model("UserSession", UserSessionSchema);

module.exports = UserSession;
