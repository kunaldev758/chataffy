// controllers/PlanController.js (Public API for users)
const Plan = require("../models/Plan");
const PlanService = require("../services/PlanService");

class PlanController {
  
  // Get all active plans (public endpoint)
  async getAvailablePlans(req, res) {
    try {
      const plans = await Plan.getActivePlans();
      
      // Remove sensitive admin fields
      const publicPlans = plans.map(plan => ({
        id: plan._id,
        name: plan.name,
        displayName: plan.displayName,
        description: plan.description,
        pricing: plan.pricing,
        limits: plan.limits,
        metadata: {
          color: plan.metadata?.color,
          icon: plan.metadata?.icon,
          popular: plan.metadata?.popular,
          trial: plan.metadata?.trial
        },
        isDefault: plan.isDefault
      }));
      
      res.json({
        success: true,
        data: publicPlans
      });
    } catch (error) {
      console.error('Error fetching available plans:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch available plans'
      });
    }
  }
  
  // Get plan comparison data
  // async getPlanComparison(req, res) {
  //   try {
  //     const plans = await Plan.getActivePlans();
      
  //     const comparison = plans.map(plan => ({
  //       id: plan._id,
  //       name: plan.name,
  //       displayName: plan.displayName,
  //       pricing: plan.pricing,
  //       features: {
  //         maxPages: plan.limits.maxPages,
  //         maxStorage: this.formatBytes(plan.limits.maxStorage),
  //         maxQueries: plan.limits.maxQueries,
  //         maxAgentsPerAccount:plan.limits.maxAgentsPerAccount,
  //         // maxDataSize: this.formatBytes(plan.limits.maxDataSize),
  //         // batchSize: plan.features.batchSize,
  //         // apiAccess: plan.features.apiAccess,
  //         // prioritySupport: plan.features.prioritySupport,
  //         // customIntegrations: plan.features.customIntegrations,
  //         // whiteLabel: plan.features.whiteLabel,
  //         // analytics: plan.features.analytics,
  //         // maxUsers: plan.restrictions.maxUsersPerAccount,
  //         // maxCollections: plan.restrictions.maxCollections
  //       },
  //       metadata: {
  //         color: plan.metadata?.color,
  //         popular: plan.metadata?.popular,
  //         trial: plan.metadata?.trial
  //       },
  //       recommended: plan.metadata?.popular || false
  //     }));
      
  //     res.json({
  //       success: true,
  //       data: comparison
  //     });
  //   } catch (error) {
  //     console.error('Error fetching plan comparison:', error);
  //     res.status(500).json({
  //       success: false,
  //       error: 'Failed to fetch plan comparison'
  //     });
  //   }
  // }
  
  // Upgrade user plan
  async upgradePlan(req, res) {
    try {
      const { userId } = req.params;
      const { planName } = req.body;
      
      if (!userId || !planName) {
        return res.status(400).json({
          success: false,
          error: 'User ID and plan name are required'
        });
      }
      
      // Validate plan exists and is active
      const targetPlan = await Plan.getPlanByName(planName);
      if (!targetPlan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found or inactive'
        });
      }
      
      // Get current plan for comparison
      const currentPlan = await PlanService.getUserPlan(userId);
      
      // Check if it's actually an upgrade (optional business logic)
      const plans = await Plan.getActivePlans();
      const currentPlanIndex = plans.findIndex(p => p.name === currentPlan.name);
      const targetPlanIndex = plans.findIndex(p => p.name === targetPlan.name);
      
      if (targetPlanIndex <= currentPlanIndex && currentPlan.name !== 'free') {
        return res.status(400).json({
          success: false,
          error: 'Cannot downgrade to a lower plan through this endpoint',
          suggestion: 'Contact support for downgrades'
        });
      }
      
      // Perform the upgrade
      const upgradeSuccess = await PlanService.upgradePlan(userId, planName);
      
      if (!upgradeSuccess) {
        return res.status(500).json({
          success: false,
          error: 'Failed to upgrade plan'
        });
      }
      
      // Get updated plan details
      const updatedPlanUsage = await PlanService.getPlanUsage(userId);
      
      res.json({
        success: true,
        message: `Successfully upgraded to ${targetPlan.displayName}`,
        data: {
          previousPlan: currentPlan.displayName,
          newPlan: targetPlan.displayName,
          planDetails: updatedPlanUsage
        }
      });
    } catch (error) {
      console.error('Error upgrading plan:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upgrade plan'
      });
    }
  }
  
  // Helper method to format bytes
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    if (bytes >= 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} Bytes`;
  }
}

module.exports = new PlanController();