// controllers/admin/PlanAdminController.js
const Plan = require("../models/Plan");
const Client = require("../models/Client");
const PlanService = require("../services/PlanService");

class PlanAdminController {
  
  // Get all plans (including inactive)
  async getAllPlans(req, res) {
    try {
      const { status, search } = req.query;
      
      let query = {};
      
      if (status && status !== 'all') {
        query.status = status;
      }
      
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { displayName: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }
      
      const plans = await Plan.find(query).sort({ order: 1, createdAt: -1 });
      
      res.json({
        success: true,
        data: plans
      });
    } catch (error) {
      console.error('Error fetching plans:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Get single plan
  async getPlan(req, res) {
    try {
      const { planId } = req.params;
      
      const plan = await Plan.findById(planId);
      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found'
        });
      }
      
      // Get usage statistics
      const usageStats = await this.getPlanUsageStats(plan.name);
      
      res.json({
        success: true,
        data: {
          plan,
          usage: usageStats
        }
      });
    } catch (error) {
      console.error('Error fetching plan:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Create new plan
  async createPlan(req, res) {
    try {
      const adminId = req.user?.id || req.body.adminId; // Get from auth middleware
      
      const planData = {
        ...req.body,
        createdBy: adminId,
        updatedBy: adminId
      };
      
      // Validate required fields
      const requiredFields = ['name', 'displayName'];
      for (const field of requiredFields) {
        if (!planData[field]) {
          return res.status(400).json({
            success: false,
            error: `${field} is required`
          });
        }
      }
      
      // Check if plan name already exists
      const existingPlan = await Plan.findOne({ name: planData.name.toLowerCase() });
      if (existingPlan) {
        return res.status(400).json({
          success: false,
          error: 'Plan with this name already exists'
        });
      }
      
      const plan = new Plan(planData);
      await plan.save();
      
      // Clear cache
      PlanService.clearCache();
      
      res.status(201).json({
        success: true,
        message: 'Plan created successfully',
        data: plan
      });
    } catch (error) {
      console.error('Error creating plan:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Update plan
  async updatePlan(req, res) {
    try {
      const { planId } = req.params;
      const adminId = req.user?.id || req.body.adminId;
      
      const updateData = {
        ...req.body,
        updatedBy: adminId
      };
      
      // Remove fields that shouldn't be updated directly
      delete updateData.createdBy;
      delete updateData.createdAt;
      delete updateData.updatedAt;
      
      const plan = await Plan.findByIdAndUpdate(
        planId,
        updateData,
        { new: true, runValidators: true }
      );
      
      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found'
        });
      }
      
      // Clear cache
      PlanService.clearCache();
      
      res.json({
        success: true,
        message: 'Plan updated successfully',
        data: plan
      });
    } catch (error) {
      console.error('Error updating plan:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Delete plan (soft delete by setting status to inactive)
  async deletePlan(req, res) {
    try {
      const { planId } = req.params;
      const { forceDelete = false } = req.query;
      
      const plan = await Plan.findById(planId);
      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found'
        });
      }
      
      // Check if plan is being used by clients
      const clientsUsingPlan = await Client.countDocuments({ plan: plan.name });
      
      if (clientsUsingPlan > 0 && !forceDelete) {
        return res.status(400).json({
          success: false,
          error: `Cannot delete plan. ${clientsUsingPlan} clients are currently using this plan.`,
          clientsCount: clientsUsingPlan,
          suggestion: 'Set status to inactive instead or use forceDelete=true'
        });
      }
      
      if (forceDelete) {
        // Hard delete
        await Plan.findByIdAndDelete(planId);
        
        // Update clients using this plan to default plan
        const defaultPlan = await Plan.getDefaultPlan();
        if (defaultPlan) {
          await Client.updateMany(
            { plan: plan.name },
            { plan: defaultPlan.name }
          );
        }
      } else {
        // Soft delete
        plan.status = 'inactive';
        await plan.save();
      }
      
      // Clear cache
      PlanService.clearCache();
      
      res.json({
        success: true,
        message: forceDelete ? 'Plan deleted successfully' : 'Plan deactivated successfully'
      });
    } catch (error) {
      console.error('Error deleting plan:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Set default plan
  async setDefaultPlan(req, res) {
    try {
      const { planId } = req.params;
      
      const plan = await Plan.findById(planId);
      if (!plan) {
        return res.status(404).json({
          success: false,
          error: 'Plan not found'
        });
      }
      
      if (plan.status !== 'active') {
        return res.status(400).json({
          success: false,
          error: 'Cannot set inactive plan as default'
        });
      }
      
      // Update the plan (pre-save middleware will handle unsetting other defaults)
      plan.isDefault = true;
      await plan.save();
      
      // Clear cache
      PlanService.clearCache();
      
      res.json({
        success: true,
        message: 'Default plan updated successfully',
        data: plan
      });
    } catch (error) {
      console.error('Error setting default plan:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Reorder plans
  async reorderPlans(req, res) {
    try {
      const { planIds } = req.body; // Array of plan IDs in new order
      
      if (!Array.isArray(planIds)) {
        return res.status(400).json({
          success: false,
          error: 'planIds must be an array'
        });
      }
      
      // Update order for each plan
      const updatePromises = planIds.map((planId, index) => 
        Plan.findByIdAndUpdate(planId, { order: index })
      );
      
      await Promise.all(updatePromises);
      
      // Clear cache
      PlanService.clearCache();
      
      res.json({
        success: true,
        message: 'Plans reordered successfully'
      });
    } catch (error) {
      console.error('Error reordering plans:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Get plan statistics and usage
  async getPlanStats(req, res) {
    try {
      const stats = await this.getAllPlanStats();
      
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('Error fetching plan stats:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Migrate users between plans
  async migrateUsers(req, res) {
    try {
      const { fromPlan, toPlan, userIds } = req.body;
      
      // Validate plans exist
      const [fromPlanDoc, toPlanDoc] = await Promise.all([
        Plan.findOne({ name: fromPlan }),
        Plan.findOne({ name: toPlan, status: 'active' })
      ]);
      
      if (!fromPlanDoc) {
        return res.status(404).json({
          success: false,
          error: `Source plan '${fromPlan}' not found`
        });
      }
      
      if (!toPlanDoc) {
        return res.status(404).json({
          success: false,
          error: `Target plan '${toPlan}' not found or inactive`
        });
      }
      
      let query = { plan: fromPlan };
      if (userIds && userIds.length > 0) {
        query.userId = { $in: userIds };
      }
      
      const result = await Client.updateMany(query, { plan: toPlan });
      
      res.json({
        success: true,
        message: `Successfully migrated ${result.modifiedCount} users from ${fromPlan} to ${toPlan}`,
        migratedCount: result.modifiedCount
      });
    } catch (error) {
      console.error('Error migrating users:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
  
  // Helper method to get usage stats for a plan
  async getPlanUsageStats(planName) {
    try {
      const clientsCount = await Client.countDocuments({ plan: planName });
      
      // You can add more detailed stats here
      return {
        totalClients: clientsCount,
        // Add more stats as needed
      };
    } catch (error) {
      console.error('Error getting plan usage stats:', error);
      return { totalClients: 0 };
    }
  }
  
  // Helper method to get all plan statistics
  async getAllPlanStats() {
    try {
      const [plans, clientStats] = await Promise.all([
        Plan.find().sort({ order: 1 }),
        Client.aggregate([
          {
            $group: {
              _id: '$plan',
              count: { $sum: 1 }
            }
          }
        ])
      ]);
      
      const clientsByPlan = {};
      clientStats.forEach(stat => {
        clientsByPlan[stat._id || 'free'] = stat.count;
      });
      
      const plansWithStats = plans.map(plan => ({
        ...plan.toObject(),
        clientsCount: clientsByPlan[plan.name] || 0
      }));
      
      const totalClients = Object.values(clientsByPlan).reduce((sum, count) => sum + count, 0);
      
      return {
        totalPlans: plans.length,
        activePlans: plans.filter(p => p.status === 'active').length,
        totalClients,
        planBreakdown: plansWithStats
      };
    } catch (error) {
      console.error('Error getting all plan stats:', error);
      throw error;
    }
  }
}

module.exports = new PlanAdminController();