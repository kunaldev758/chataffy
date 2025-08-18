const Client = require('../models/Client');
const Plan = require('../models/Plan');
const User = require('../models/User');
const { sendPlanDowngradeEmail } = require('./emailService');

async function downgradeExpiredPlans() {
  try {
    // Find the default/free plan name
    const defaultPlan = await Plan.findOne({ isDefault: true }) || { name: 'free' };

    // Find all clients whose plan has expired and is not already on the default plan
    const now = new Date();
    const expiredClients = await Client.find({
      planExpiry: { $ne: null, $lte: now },
      plan: { $ne: defaultPlan.name }
    });

    if (expiredClients.length === 0) {
      console.log('No expired plans to downgrade.');
      return;
    }

    // Downgrade all expired clients
    const result = await Client.updateMany(
      {
        planExpiry: { $ne: null, $lte: now },
        plan: { $ne: defaultPlan.name }
      },
      {
        plan: defaultPlan.name,
        planStatus: 'inactive'
      }
    );

    // Send downgrade email to each affected user
    for (const client of expiredClients) {
      const user = await User.findById(client.userId);
      if (user) {
        await sendPlanDowngradeEmail(user, defaultPlan.name);
      }
    }

    console.log(`Downgraded ${result.modifiedCount} users to ${defaultPlan.name} plan.`);
  } catch (error) {
    console.error('Error downgrading expired plans:', error);
  }
}

module.exports = { downgradeExpiredPlans }; 