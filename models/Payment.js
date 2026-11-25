const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    planName: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly"],
      required: true,
    },
    provider: {
      type: String,
      default: "razorpay",
    },
    currency: {
      type: String,
      default: "INR",
    },
    amountInr: {
      type: Number,
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
    },
    // Original plan price when the plan is listed in USD. Used for the existing $ revenue total.
    amountUsd: {
      type: Number,
      default: null,
    },
    fxRate: {
      type: Number,
      default: null,
    },
    razorpayOrderId: {
      type: String,
      default: null,
    },
    razorpayPaymentId: {
      type: String,
      default: null,
    },
    razorpaySignature: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["created", "fulfilling", "paid", "failed"],
      default: "created",
    },
    paidAt: {
      type: Date,
      default: null,
    },
    receipt: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

paymentSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
