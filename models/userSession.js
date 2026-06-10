const mongoose = require("mongoose");
const { Schema } = mongoose;

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const userSession = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    platform: {
      type: String,
      enum: ['local', 'google', 'bigcommerce', 'shopify'],
      default: 'local',
    },
    token: {
      type: String,
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

userSession.index({ userId: 1, platform: 1, token: 1 }, { unique: true });

const UserSession = mongoose.model("UserSession", userSession);
module.exports = UserSession;
