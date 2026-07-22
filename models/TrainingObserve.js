const mongoose = require("mongoose");

const trainingObserveSchema = new mongoose.Schema(
  {
    trainingRunId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["completed", "failed"],
      required: true,
    },
    failedReason: {
      type: String,
      default: null,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    finishedAt: {
      type: Date,
      required: true,
    },
    totalChunks: {
      type: Number,
      default: 0,
    },
    durationMs: {
      type: Number,
      required: true,
    },
  },
);

const TrainingObserve = mongoose.model("TrainingObserve", trainingObserveSchema);

module.exports = TrainingObserve;
