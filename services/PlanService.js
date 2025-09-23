// services/PlanService.js
const Client = require("../models/Client");
const Plan = require("../models/Plan");
const Agent = require("../models/Agent");
// const Chats = require("../models/Conversation");
const Conversation = require("../models/Conversation");
// const QdrantVectorStoreManager = require("./QdrantService");
const {planUpgradeQueue} = require("./jobService");

class PlanService {
  // Cache for plans to avoid frequent database queries
  static plansCache = null;
  static cacheExpiry = null;
  static CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  // Get all plans from cache or database
  static async getAllPlans() {
    try {
      // Check if cache is valid
      if (this.plansCache && this.cacheExpiry && Date.now() < this.cacheExpiry) {
        return this.plansCache;
      }

      // Fetch from database
      const plans = await Plan.getActivePlans();
      
      // Update cache
      this.plansCache = plans;
      this.cacheExpiry = Date.now() + this.CACHE_DURATION;
      
      return plans;
    } catch (error) {
      console.error('Error fetching plans:', error);
      // Return default fallback plan if database fails
      return [this.getFallbackPlan()];
    }
  }

  // Clear cache (call this when plans are updated)
  static clearCache() {
    this.plansCache = null;
    this.cacheExpiry = null;
  }

  // Get fallback plan if database is unavailable
  static getFallbackPlan() {
    return {
      name: 'free',
      displayName: 'Free Plan',
      limits: {
        maxStorage: 1000 * 1024, // 1000KB
        maxPages: 50,
        maxQueries: 100,
        maxAgentsPerAccount:1,
      },
      status: 'active',
      isDefault: true
    };
  }

  static async getUserPlan(userId) {
    try {
      const client = await Client.findOne({ userId });
      let planName = 'free'; // default
      
      if (client && client.plan) {
        planName = client.plan;
      }
      
      // Get plan from database
      const plan = await Plan.getPlanByName(planName);
      
      if (plan) {
        return plan;
      }
      
      // If plan not found, get default plan
      const defaultPlan = await Plan.getDefaultPlan();
      if (defaultPlan) {
        return defaultPlan;
      }
      
      // Ultimate fallback
      return this.getFallbackPlan();
      
    } catch (error) {
      console.error('Error fetching user plan:', error);
      return this.getFallbackPlan();
    }
  }

  static async checkDataSizeLimit(userId, contentSize) {
    const client = await Client.findOne({userId});
    const plan = await PlanService.getUserPlan(userId);

    if (client.currentDataSize+contentSize > plan.limits.maxStorage) {
      await Client.updateOne(
        { userId },
        { $set: { "upgradePlanStatus.storageLimitExceeded" : true }  }
      );
      return false;
    } else {
      await Client.updateOne(
        { userId },
        { $inc: { currentDataSize: contentSize } }
      );
      return true;
    }
  }

  static async getTrainingModel(userId) {
    const plan = await this.getUserPlan(userId);
    if (plan.name === 'free') {
      return require("../models/TrainingListFreeUsers");
    }
    return require("../models/OpenaiTrainingList");
  }

  static async upgradePlan(userId, newPlanName) {
    try {
      // Validate that the new plan exists
      const newPlan = await Plan.getPlanByName(newPlanName);
      if (!newPlan) {
        throw new Error(`Plan '${newPlanName}' not found or inactive`);
      }
         // Get old plan to check if migration is needed
         const oldPlan = await this.getUserPlan(userId);

         if(newPlan.order>oldPlan.order){
          await Client.updateOne({ userId },{ $set: { upgradePlanStatus: { agentLimitExceeded: false,chatLimitExceeded:false,storageLimitExceeded:false } } });
         }

      // Update client's plan
      // Update the client's plan and retrieve the updated client document
      const updatedClient = await Client.findOneAndUpdate(
        { userId },
        { plan: newPlanName },
        { new: true }
      );
      
      // Migrate data from free users collection to main collection if upgrading from free
      if (oldPlan.name === 'free' && newPlanName !== 'free') {

        await planUpgradeQueue.add("migrateUserData", {
          userId,
          sourceCollection: updatedClient.qdrantIndexName,
          targetCollection: updatedClient.qdrantIndexNamePaid
        });
        // await this.migrateFreeUserData(userId);
        // // Qdrant migration
        // const sourceCollection = updatedClient.qdrantIndexName;
        // const targetCollection = updatedClient.qdrantIndexNamePaid;
        // const qdrantManager = new QdrantVectorStoreManager(sourceCollection);
        // await qdrantManager.migrateCollection(sourceCollection, targetCollection);
      }
      
      return true;
    } catch (error) {
      console.error('Error upgrading plan:', error);
      return false;
    }
  }

  // Get plan usage statistics
  static async getPlanUsage(userId) {
    try {
      // --- AGENTS USAGE ---
      let totalAgents = 0;
      try {
        totalAgents = await Agent.countDocuments({ userId });
      } catch (e) {
        totalAgents = 0;
      }

      let totalChats = 0;

      try {
        const client = await Client.findOne({userId});
      
        if (!client) throw new Error("Client not found");
      
        // For free plan → start cycle from account creation date
        const baseDate = (client.plan === "free") 
          ? new Date(client.createdAt) 
          : new Date(client.planPurchaseDate);
      
        const now = new Date();
      
        // Calculate start of the current monthly cycle
        let monthsSinceBase = 
          (now.getFullYear() * 12 + now.getMonth()) -
          (baseDate.getFullYear() * 12 + baseDate.getMonth());
      
        let cycleStart = new Date(baseDate);
        cycleStart.setMonth(baseDate.getMonth() + monthsSinceBase);
      
        let cycleEnd = new Date(cycleStart);
        cycleEnd.setMonth(cycleStart.getMonth() + 1);
      
        // Count chats in the current cycle
        totalChats = await Conversation.countDocuments({
          userId,
          is_started: true,
          createdAt: { $gte: cycleStart, $lt: cycleEnd }
        });
      
      } catch (e) {
        console.error(e);
        totalChats = 0;
      }

      return {
          totalAgents,
          totalChats,
      };
    } catch (error) {
      console.error('Error getting plan usage:', error);
      throw error;
    }
  }

  // Check if user can perform action based on plan limits
  static async checkPlanLimits(userId, action) {
    try {
      const plan = await PlanService.getUserPlan(userId);
      const usage = await PlanService.getPlanUsage(userId);

      const checks = {
        canMakeQueries: true,
        canAddAgents: true,
        message: '',
        upgradeSuggested: false
      };

      switch (action) {
        case 'add_agent': {
          const maxAgents = plan.limits?.maxAgentsPerAccount || 1;
          checks.canAddAgents = usage.totalAgents < maxAgents;
          if (!checks.canAddAgents) {
            checks.message = `Cannot add agent. Plan limit: ${maxAgents}, Current: ${usage.totalAgents}`;
            checks.upgradeSuggested = true;
          }
          break;
        }
        case 'query': {
          const maxQueries = plan.limits?.maxQueries || 1000;
          checks.canMakeQueries = usage.totalChats < maxQueries;
          if (!checks.canMakeQueries) {
            checks.message = `Cannot make query. Plan limit: ${maxQueries}, Current: ${usage.totalChats}`;
            checks.upgradeSuggested = true;
          }
          break;
        }
        default:
          // No action, keep all checks as true
          break;
      }

      return checks;
    } catch (error) {
      console.error('Error checking plan limits:', error);
      return {
        canMakeQueries: false,
        canAddAgents: false,
        message: 'Error checking plan limits',
        upgradeSuggested: false
      };
    }
  } 
}

module.exports = PlanService;