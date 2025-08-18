const mongoose = require("mongoose");
const qdrantUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: Date, default: Date.now },
  vectorsAdded: { type: Number, default: 0 },
  vectorsDeleted: { type: Number, default: 0 },
  apiCalls: { type: Number, default: 0 },
  storageMB: { type: Number, default: 0 },
  collectionName: { type: String },
  estimatedCost: {
    type: Map,
    of: Number,
    default: {
      requests: 0,
      storage: 0
    }
  },
});

const QdrantUsage = mongoose.model("QdrantUsage", qdrantUsageSchema);

module.exports = QdrantUsage;

