// services/PlanService.js
const Client = require("../models/Client");
const Plan = require("../models/Plan");
const Agent = require("../models/Agent");
const HumanAgent = require("../models/HumanAgent");
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
        maxQueries: 100,
        maxAgentsPerAccount:1,
        maxHumanAgentsPerAccount:1,
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

  static async checkDataSizeLimit(userId,agentId, contentSize) {
    const client = await Client.findOne({userId});
    const plan = await PlanService.getUserPlan(userId);

    const maxStorage = (client.customLimits?.isCustomLimits && client.customLimits?.maxStorage != null)
      ? client.customLimits.maxStorage
      : plan.limits.maxStorage;

    if (client.currentDataSize+contentSize > maxStorage) {
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
      await Agent.updateOne(
        { _id: agentId },
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

  /**
   * Persist per-client limits as copies of the global plan document (superadmin can edit later).
   * Merges with getFallbackPlan() so missing fields still get defaults (never all-null / isCustomLimits false).
   * @param {import('mongoose').Document|null|object} plan — Plan doc from DB, plain object, or null
   */
  static buildCustomLimitsFromPlan(plan) {
    const fb = PlanService.getFallbackPlan().limits;
    let raw = {};
    if (plan && plan.limits) {
      raw =
        typeof plan.limits.toObject === 'function'
          ? plan.limits.toObject()
          : { ...plan.limits };
    }
    const lim = { ...fb, ...raw };
    return {
      isCustomLimits: true,
      maxQueries: lim.maxQueries ?? null,
      maxHumanAgents: lim.maxHumanAgentsPerAccount ?? null,
      maxAgents: lim.maxAgentsPerAccount ?? null,
      maxStorage: lim.maxStorage ?? null,
    };
  }

  /**
   * After creating a Client row, copy the current global plan limits into customLimits (default plan: free).
   */
  static async seedCustomLimitsForNewClient(userId) {
    try {
      const client = await Client.findOne({ userId });
      if (!client) return;
      const planName = (client.plan || 'free').toLowerCase();
      const planDoc = await Plan.getPlanByName(planName);
      const customLimits = PlanService.buildCustomLimitsFromPlan(planDoc);
      await Client.updateOne({ _id: client._id }, { $set: { customLimits } });
    } catch (e) {
      console.error('seedCustomLimitsForNewClient:', e);
    }
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
          await Client.updateOne({ userId },{ $set: { upgradePlanStatus: { agentLimitExceeded: false,chatLimitExceeded:false,storageLimitExceeded:false,humanAgentLimitExceeded:false } } });
         }

      const customLimits = PlanService.buildCustomLimitsFromPlan(newPlan);

      const updatedClient = await Client.findOneAndUpdate(
        { userId },
        {
          $set: {
            plan: newPlanName,
            customLimits,
          },
        },
        { new: true }
      );
      
      // Migrate data from free users collection to main collection if upgrading from free
      if (oldPlan.name === 'free' && newPlanName !== 'free') {

        // Migrate data for each agent of this user
        const agents = await Agent.find({ userId });
        for (const agent of agents) {
          if (agent.qdrantIndexName && agent.qdrantIndexNamePaid) {
            await planUpgradeQueue.add("migrateUserData", {
              userId,
              agentId: agent._id,
              sourceCollection: agent.qdrantIndexName,
              targetCollection: agent.qdrantIndexNamePaid
            });
          }
        }
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
      let totalHumanAgents = 0;
      try {
        totalAgents = await Agent.countDocuments({ userId, isDeleted: false });
        totalHumanAgents = await HumanAgent.countDocuments({ userId, isDeleted: false, isClient: false });
      } catch (e) {
        totalAgents = 0;
        totalHumanAgents = 0;
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
      
        // Calculate how many full billing months have elapsed.
        // A month is only "complete" once the current day-of-month has reached
        // the billing day (e.g. created on the 27th → cycle renews on the 27th).
        let monthsSinceBase = 
          (now.getFullYear() * 12 + now.getMonth()) -
          (baseDate.getFullYear() * 12 + baseDate.getMonth());

        if (now.getDate() < baseDate.getDate()) {
          monthsSinceBase -= 1;
        }
        if (monthsSinceBase < 0) monthsSinceBase = 0;
      
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
          totalHumanAgents,
      };
    } catch (error) {
      console.error('Error getting plan usage:', error);
      throw error;
    }
  }

  // Resolve effective limits for a user (custom limits override plan limits)
  static async getEffectiveLimits(userId) {
    const client = await Client.findOne({ userId });
    const plan = await PlanService.getUserPlan(userId);

    if (client?.customLimits?.isCustomLimits) {
      return {
        maxAgentsPerAccount: client.customLimits.maxAgents ?? plan.limits?.maxAgentsPerAccount ?? 1,
        maxHumanAgentsPerAccount: client.customLimits.maxHumanAgents ?? plan.limits?.maxHumanAgentsPerAccount ?? 1,
        maxQueries: client.customLimits.maxQueries ?? plan.limits?.maxQueries ?? 1000,
        maxStorage: client.customLimits.maxStorage ?? plan.limits?.maxStorage ?? 1024 * 1024,
        isCustom: true,
      };
    }

    return {
      maxAgentsPerAccount: plan.limits?.maxAgentsPerAccount ?? 1,
      maxHumanAgentsPerAccount: plan.limits?.maxHumanAgentsPerAccount ?? 1,
      maxQueries: plan.limits?.maxQueries ?? 1000,
      maxStorage: plan.limits?.maxStorage ?? 1024 * 1024,
      isCustom: false,
    };
  }

  // Check if user can perform action based on plan limits
  static async checkPlanLimits(userId, action) {
    try {
      const limits = await PlanService.getEffectiveLimits(userId);
      const usage = await PlanService.getPlanUsage(userId);

      const checks = {
        canMakeQueries: true,
        canAddAgents: true,
        canAddHumanAgents: true,
        message: '',
        upgradeSuggested: false
      };

      switch (action) {
        case 'add_agent': {
          const maxAgents = limits.maxAgentsPerAccount;
          checks.canAddAgents = usage.totalAgents < maxAgents;
          if (!checks.canAddAgents) {
            checks.message = `Cannot add agent. Limit: ${maxAgents}, Current: ${usage.totalAgents}`;
            checks.upgradeSuggested = !limits.isCustom;
          }
          break;
        }
        case 'add_human_agent': {
          const maxHumanAgents = limits.maxHumanAgentsPerAccount;
          checks.canAddHumanAgents = usage.totalHumanAgents < maxHumanAgents;
          if (!checks.canAddHumanAgents) {
            checks.message = `Cannot add human agent. Limit: ${maxHumanAgents}, Current: ${usage.totalHumanAgents}`;
            checks.upgradeSuggested = !limits.isCustom;
          }
          break;
        }
        case 'query': {
          const maxQueries = limits.maxQueries;
          checks.canMakeQueries = usage.totalChats < maxQueries;
          if (!checks.canMakeQueries) {
            checks.message = `Cannot make query. Limit: ${maxQueries}, Current: ${usage.totalChats}`;
            checks.upgradeSuggested = !limits.isCustom;
          }
          break;
        }
        default:
          break;
      }

      return checks;
    } catch (error) {
      console.error('Error checking plan limits:', error);
      return {
        canMakeQueries: false,
        canAddAgents: false,
        canAddHumanAgents: false,
        message: 'Error checking plan limits',
        upgradeSuggested: false
      };
    }
  } 
}

module.exports = PlanService;