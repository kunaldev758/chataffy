const mongoose = require("mongoose");

const { Schema } = mongoose;

const impersonationSessionSchema = new Schema(
  {
    jti: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: false, index: true },
    superAdminId: {
      type: Schema.Types.ObjectId,
      ref: "SuperAdmin",
      required: true,
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, required: false, index: true },
  },
  { timestamps: true }
);

// Auto-delete expired sessions
impersonationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("ImpersonationSession", impersonationSessionSchema);

