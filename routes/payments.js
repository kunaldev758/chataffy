const express = require('express');
const router = express.Router();
const paypalService = require('../services/paypalService');
const PlanService = require('../services/PlanService');
const EmailService = require('../services/emailService');
const Client = require('../models/Client');
const User = require('../models/User');
const checkoutNodeJssdk = require('@paypal/checkout-server-sdk');
const middleware = require('../middleware/authMiddleware');

// One-time payment order creation
router.post('/create-order',middleware, async (req, res) => {
  const { value = '10.00', currency = 'USD' } = req.body;
  const request = new checkoutNodeJssdk.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: currency,
        value: value
      }
    }]
  });

  try {
    const order = await paypalService.client().execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/capture-payment',middleware, async (req, res) => {
  const { orderID, plan, billing_cycle,userId } = req.body;
  
  const request = new checkoutNodeJssdk.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});

  try {
    const capture = await paypalService.client().execute(request);
    const amount = capture.result.purchase_units[0].payments.captures[0].amount.value;
    // Here you would:

    // 1. Update the user's subscription/plan
    await PlanService.upgradePlan(userId,plan.name)
        // 2. Save the payment to your database
        // Calculate planExpiry based on billing_cycle
        const now = new Date();
        const purchaseDate = new Date();
        let planExpiry;
        
        if (billing_cycle === 'yearly') {
          planExpiry = new Date(now.setFullYear(now.getFullYear() + 1));
        } else {
          // Default to monthly if not yearly
          planExpiry = new Date(now.setMonth(now.getMonth() + 1));
        }

        await Client.findOneAndUpdate(
          { userId: userId },
          {
            $set: { 
              planStatus: 'active', 
              paymentStatus: 'paid', 
              billingCycle: billing_cycle,
              planExpiry: planExpiry,
              planPurchaseDate: purchaseDate,
            },
            $inc: { totalAmountPaid: Number(amount) }
          }
        );
    // 3. Send confirmation email
    const user = await User.findById(userId); // Replace `User` with your user model
    await EmailService.sendPlanUpgradeEmail(user, plan.name, amount, billing_cycle);
    
    const paymentData = {
      id: capture.result.id,
      status: capture.result.status,
      plan: plan,
      amount: capture.result.purchase_units[0].payments.captures[0].amount.value,
      billing_cycle: billing_cycle,
      payer: capture.result.payer
    };
    
    res.json({
      success: true,
      payment: paymentData,
      plan: plan,
      amount: paymentData.amount
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// For subscription payments (if you want recurring billing)
router.post('/capture-subscription',middleware, async (req, res) => {
  const { subscriptionID } = req.body;
  
  try {
    // Handle subscription activation
    // You'd typically store subscription details in your database
    res.json({ success: true, subscriptionID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancel-plan', middleware, async (req, res) => {
  const { userId } = req.body;

  try {
    // Update the client's plan status to 'cancelled'
    await Client.findOneAndUpdate(
      { userId: userId },
      { $set: { planStatus: 'cancelled' } }
    );

    // Optionally, you can add logic to handle any additional cleanup or notifications

    res.json({ success: true, message: 'Plan has been cancelled successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Subscription creation (returns PayPal subscription approval link)
router.post('/create-subscription',middleware, async (req, res) => {
  const { plan_id } = req.body;
  const request = new checkoutNodeJssdk.subscriptions.SubscriptionsCreateRequest();
  request.requestBody({
    plan_id: plan_id
  });

  try {
    const subscription = await paypalService.client().execute(request);
    res.json(subscription.result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router; 