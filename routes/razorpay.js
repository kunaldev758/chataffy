const express = require("express");
const router = express.Router();
const middleware = require("../middleware/authMiddleware");
const Plan = require("../models/Plan");
const Payment = require("../models/Payment");
const Client = require("../models/Client");
const User = require("../models/User");
const PlanService = require("../services/PlanService");
const EmailService = require("../services/emailService");
const razorpayService = require("../services/razorpayService");

function sendError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({
    success: false,
    error: error.message || "Payment failed",
  });
}

function planExpiryFromCycle(billingCycle) {
  const now = new Date();
  if (billingCycle === "yearly") {
    return new Date(now.setFullYear(now.getFullYear() + 1));
  }
  return new Date(now.setMonth(now.getMonth() + 1));
}

async function publicPlanPayload(planName) {
  const plan = await Plan.getPlanByName(planName);
  if (!plan) return { name: planName, displayName: planName };
  return {
    name: plan.name,
    displayName: plan.displayName,
    description: plan.description,
    metadata: plan.metadata,
  };
}

async function fulfillPayment(payment) {
  const upgraded = await PlanService.upgradePlan(payment.userId, payment.planName);
  if (!upgraded) {
    throw new Error("Payment was received, but the plan could not be activated. Contact support with your payment id.");
  }

  const revenueIncrement =
    payment.amountUsd != null ? Number(payment.amountUsd) : 0;

  await Client.findOneAndUpdate(
    { userId: payment.userId },
    {
      $set: {
        planStatus: "active",
        paymentStatus: "paid",
        billingCycle: payment.billingCycle,
        planExpiry: planExpiryFromCycle(payment.billingCycle),
        planPurchaseDate: new Date(),
      },
      $inc: {
        totalAmountPaidInr: Number(payment.amountInr) || 0,
        ...(revenueIncrement > 0 ? { totalAmountPaid: revenueIncrement } : {}),
      },
    }
  );

  const user = await User.findById(payment.userId);
  if (user?.email) {
    await EmailService.sendPlanUpgradeEmail(
      user,
      payment.planName,
      payment.amountInr,
      payment.billingCycle,
      "INR"
    );
  }
}

async function claimAndFulfill(payment, { paymentId, signature }) {
  if (payment.status === "paid") {
    return { alreadyProcessed: true, payment };
  }

  const staleLock = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      $or: [
        { status: "created" },
        { status: "fulfilling", updatedAt: { $lt: staleLock } },
      ],
    },
    {
      $set: {
        status: "fulfilling",
        razorpayPaymentId: paymentId || payment.razorpayPaymentId,
        razorpaySignature: signature || payment.razorpaySignature,
      },
    },
    { new: true }
  );

  if (!claimed) {
    const current = await Payment.findById(payment._id);
    if (current?.status === "paid") {
      return { alreadyProcessed: true, payment: current };
    }
    const error = new Error("Payment confirmation is already in progress. Wait a moment and refresh.");
    error.statusCode = 409;
    throw error;
  }

  try {
    await fulfillPayment(claimed);
    claimed.status = "paid";
    claimed.paidAt = new Date();
    await claimed.save();
    return { alreadyProcessed: false, payment: claimed };
  } catch (error) {
    await Payment.updateOne(
      { _id: claimed._id, status: "fulfilling" },
      { $set: { status: "created" } }
    );
    throw error;
  }
}

async function assertGatewayPayment(orderId, paymentId, expectedPaise) {
  const razorpay = razorpayService.getClient();
  const gatewayPayment = await razorpay.payments.fetch(paymentId);
  const status = gatewayPayment?.status;
  const captured = status === "captured" || status === "authorized";
  if (!captured || gatewayPayment.order_id !== orderId) {
    const error = new Error("Payment was not captured by Razorpay.");
    error.statusCode = 400;
    throw error;
  }
  if (Number(gatewayPayment.amount) !== Number(expectedPaise)) {
    const error = new Error("Paid amount does not match the plan price.");
    error.statusCode = 400;
    throw error;
  }
  return gatewayPayment;
}

router.post("/create-order", middleware, async (req, res) => {
  try {
    const credentials = razorpayService.assertConfigured();
    const planName = String(req.body.plan_name || req.body.planName || "")
      .trim()
      .toLowerCase();
    const billingCycle = req.body.billing_cycle === "yearly" || req.body.billingCycle === "yearly"
      ? "yearly"
      : "monthly";
    const userId = req.body.userId;

    if (!planName) {
      return res.status(400).json({ success: false, error: "Plan is required." });
    }

    const plan = await Plan.getPlanByName(planName);
    if (!plan) {
      return res.status(404).json({ success: false, error: "Plan not found." });
    }

    const charge = razorpayService.resolveInrCharge(plan, billingCycle);
    if (charge.error) {
      return res.status(400).json({ success: false, error: charge.error });
    }
    if (charge.amountPaise < 100) {
      return res.status(400).json({ success: false, error: "Amount must be at least ₹1." });
    }

    const payment = await Payment.create({
      userId,
      planName: plan.name,
      billingCycle,
      amountInr: charge.amountInr,
      amountPaise: charge.amountPaise,
      amountUsd: charge.amountUsd,
      fxRate: charge.fxRate,
      currency: "INR",
      status: "created",
    });

    try {
      const razorpay = razorpayService.getClient();
      const receipt = `cf_${String(payment._id).slice(-12)}`;
      const order = await razorpay.orders.create({
        amount: charge.amountPaise,
        currency: "INR",
        receipt,
        notes: {
          userId: String(userId),
          planName: plan.name,
          billingCycle,
          paymentRecordId: String(payment._id),
        },
      });

      payment.razorpayOrderId = order.id;
      payment.receipt = receipt;
      await payment.save();

      return res.json({
        success: true,
        keyId: credentials.keyId,
        orderId: order.id,
        amount: charge.amountInr,
        amountPaise: charge.amountPaise,
        currency: "INR",
        planName: plan.name,
        billingCycle,
      });
    } catch (error) {
      payment.status = "failed";
      await payment.save();
      throw error;
    }
  } catch (error) {
    console.error("[razorpay] create-order failed:", error);
    return sendError(res, error);
  }
});

router.post("/verify-payment", middleware, async (req, res) => {
  try {
    razorpayService.assertConfigured();
    const userId = req.body.userId;
    const orderId = req.body.razorpay_order_id;
    const paymentId = req.body.razorpay_payment_id;
    const signature = req.body.razorpay_signature;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        error: "Payment id, order id, and signature are required.",
      });
    }

    const valid = razorpayService.verifyCheckoutSignature({
      orderId,
      paymentId,
      signature,
    });
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: "Payment signature verification failed.",
      });
    }

    const payment = await Payment.findOne({ razorpayOrderId: orderId, userId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment order was not found for this account.",
      });
    }

    await assertGatewayPayment(orderId, paymentId, payment.amountPaise);
    const result = await claimAndFulfill(payment, { paymentId, signature });
    const plan = await publicPlanPayload(result.payment.planName);

    return res.json({
      success: true,
      alreadyProcessed: result.alreadyProcessed,
      currency: "INR",
      amount: result.payment.amountInr,
      plan,
      payment: {
        id: result.payment.razorpayPaymentId,
        orderId: result.payment.razorpayOrderId,
        status: result.payment.status,
      },
    });
  } catch (error) {
    console.error("[razorpay] verify-payment failed:", error);
    return sendError(res, error);
  }
});

// Razorpay server-to-server backup. Checkout still verifies in /verify-payment.
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.get("x-razorpay-signature");
    if (!razorpayService.verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(400).json({ success: false, error: "Invalid webhook signature." });
    }

    const event = req.body?.event;
    const entity = req.body?.payload?.payment?.entity;
    if (!entity || (event !== "payment.captured" && event !== "order.paid")) {
      return res.json({ success: true, ignored: true });
    }

    const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
    if (!payment) {
      return res.json({ success: true, ignored: true });
    }

    if (Number(entity.amount) !== Number(payment.amountPaise)) {
      console.error("[razorpay] webhook amount mismatch", {
        orderId: entity.order_id,
        expected: payment.amountPaise,
        received: entity.amount,
      });
      return res.status(400).json({ success: false, error: "Amount mismatch." });
    }

    if (entity.status !== "captured" && entity.status !== "authorized") {
      return res.json({ success: true, ignored: true });
    }

    await claimAndFulfill(payment, { paymentId: entity.id, signature: null });
    return res.json({ success: true });
  } catch (error) {
    console.error("[razorpay] webhook failed:", error);
    return sendError(res, error);
  }
});

module.exports = router;
