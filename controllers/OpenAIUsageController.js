const Usage = require('../models/UsageSchema');
const Client = require('../models/Client');

class UsageController {
  // Convert dollar cost to credits (1 dollar = 10 credits)
  static dollarsToCredits(dollarAmount) {
    return Math.ceil(dollarAmount * 10);
  }

  // Calculate cost based on tokens and vector operations
  static calculateCost(inputTokens = 0, outputTokens = 0, vectorCount = 0) {
    // Example pricing (adjust according to your actual pricing)
    const INPUT_TOKEN_RATE = 0.0001;    // $0.0001 per input token
    const OUTPUT_TOKEN_RATE = 0.0002;   // $0.0002 per output token
    const VECTOR_OPERATION_RATE = 0.0001; // $0.0001 per vector operation

    return (
      (inputTokens * INPUT_TOKEN_RATE) +
      (outputTokens * OUTPUT_TOKEN_RATE) +
      (vectorCount * VECTOR_OPERATION_RATE)
    );
  }

  // Record usage and update client credits
  static async recordUsage(userId, operation, details) {  
    try {

      // Calculate cost in dollars
      const cost = this.calculateCost(
        details.inputTokens,
        details.outputTokens,
        details.vectorCount
      );

      // Convert to credits
      const creditsRequired = this.dollarsToCredits(cost);

      // Check if client has enough credits
      const client = await Client.findOne({ userId }).session(session);
      if (!client) {
        throw new Error('Client not found');
      }

      const remainingCredits = client.credits.total - client.credits.used;
      if (remainingCredits < creditsRequired) {
        throw new Error('Insufficient credits');
      }

      // Record usage
      const usage = new Usage({
        userId,
        operation,
        details: {
          ...details,
          cost,
        },
      });
      await usage.save({ session });

      // Update client credits
      await Client.findOneAndUpdate(
        { userId },
        { $inc: { 'credits.used': creditsRequired } },
        // { session, new: true }
      );

      await session.commitTransaction();
      return { usage, creditsUsed: creditsRequired, remainingCredits: remainingCredits - creditsRequired };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }


  static async recordUsageOfChat(userId, cost) {  
    try {
      // Convert to credits
      const creditsRequired = this.dollarsToCredits(cost);

      // Check if client has enough credits
      const client = await Client.findOne({ userId });
      if (!client) {
        throw new Error('Client not found');
      }

      const remainingCredits = client.credits.total - client.credits.used;
      if (remainingCredits < creditsRequired) {
        throw new Error('Insufficient credits');
      }
      // Update client credits
      await Client.findOneAndUpdate(
        { userId },
        { $inc: { 'credits.used': creditsRequired } },
      );

      return { creditsUsed: creditsRequired, remainingCredits: remainingCredits - creditsRequired };
    } catch (error) {
      throw error;
    } 
  }

  // Get usage statistics for a user
  static async getUserUsageStats(userId) {
    const usages = await Usage.find({ userId });
    const totalCost = usages.reduce((sum, usage) => sum + (usage.details.cost || 0), 0);
    const totalCreditsUsed = this.dollarsToCredits(totalCost);
    
    return {
      totalUsages: usages.length,
      totalCost,
      totalCreditsUsed,
      usagesByOperation: await Usage.aggregate([
        { $match: { userId } },
        { $group: {
          _id: '$operation',
          count: { $sum: 1 },
          totalCost: { $sum: '$details.cost' }
        }}
      ])
    };
  }
}

const OpenAIUsageController = {};

// Express route handlers
  // Get all usages
  OpenAIUsageController.getAllUsages =  async (req, res) => {
    try {
      const usages = await Usage.find();
      res.json(usages);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usages' });
    }
  },

  // Get usage by ID
  OpenAIUsageController.getUsageById = async (req, res) => {
    try {
      const usage = await Usage.findById(req.params.id);
      if (!usage) {
        return res.status(404).json({ error: 'Usage not found' });
      }
      res.json(usage);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usage' });
    }
  },

  // Get user usage statistics
  OpenAIUsageController.getUserStats =  async (req, res) => {
    try {
      const stats = await UsageController.getUserUsageStats(req.params.userId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usage statistics' });
    }
  },

  // Record new usage
  OpenAIUsageController.recordUsage = async (req, res) => {
    try {
      const { userId, operation, details } = req.body;
      const result = await UsageController.recordUsage(userId, operation, details);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  OpenAIUsageController.recordUsageOfChat = async (userId,cost) => {
    try {
      // const { userId, cost, details } = req.body;
      const result = await UsageController.recordUsageOfChat(userId, cost);
      // res.json(result);
      return result;
    } catch (error) {
      // res.status(500).json({ error: error.message });
      throw error;
    }
  }
// };

module.exports = OpenAIUsageController ;