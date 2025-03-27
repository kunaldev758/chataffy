// const Usage = require('../models/UsageSchema');
// const Client = require('../models/Client');

// class UsageController {
//   // Convert dollar cost to credits (1 dollar = 10 credits)
//   static dollarsToCredits(dollarAmount) {
//     return Math.ceil(dollarAmount * 10);
//   }

//   // Calculate cost based on tokens and vector operations
//   static calculateCost(inputTokens = 0, outputTokens = 0, vectorCount = 0) {
//     // Example pricing (adjust according to your actual pricing)
//     const INPUT_TOKEN_RATE = 0.0001;    // $0.0001 per input token
//     const OUTPUT_TOKEN_RATE = 0.0002;   // $0.0002 per output token
//     const VECTOR_OPERATION_RATE = 0.0001; // $0.0001 per vector operation

//     return (
//       (inputTokens * INPUT_TOKEN_RATE) +
//       (outputTokens * OUTPUT_TOKEN_RATE) +
//       (vectorCount * VECTOR_OPERATION_RATE)
//     );
//   }

//   // Record usage and update client credits
//   static async recordUsage(userId, operation, details) {  
//     try {
//       // Calculate cost in dollars
//       const cost = this.calculateCost(
//         details.inputTokens,
//         details.outputTokens,
//         details.vectorCount
//       );

//       // Convert to credits
//       const creditsRequired = this.dollarsToCredits(cost);

//       // Check if client has enough credits
//       const client = await Client.findOne({ userId });
//       if (!client) {
//         throw new Error('Client not found');
//       }

//       const remainingCredits = client.credits.total - client.credits.used;
//       if (remainingCredits < creditsRequired) {
//         throw new Error('Insufficient credits');
//       }

//       // Record usage
//       const usage = new Usage({
//         userId,
//         operation,
//         details: {
//           ...details,
//           cost,
//         },
//       });
//       await usage.save();

//       // Update client credits
//       await Client.findOneAndUpdate(
//         { userId },
//         { $inc: { 'credits.used': creditsRequired } }
//       );

//       return { 
//         usage, 
//         creditsUsed: creditsRequired, 
//         remainingCredits: remainingCredits - creditsRequired 
//       };
//     } catch (error) {
//       throw error;
//     }
//   }

//   static async recordUsageOfChat(userId, cost) {  
//     try {
//       // Convert to credits
//       const creditsRequired = this.dollarsToCredits(cost);

//       // Check if client has enough credits
//       const client = await Client.findOne({ userId });
//       if (!client) {
//         throw new Error('Client not found');
//       }

//       const remainingCredits = client.credits.total - client.credits.used;
//       if (remainingCredits < creditsRequired) {
//         throw new Error('Insufficient credits');
//       }
      
//       // Update client credits
//       await Client.findOneAndUpdate(
//         { userId },
//         { $inc: { 'credits.used': creditsRequired } }
//       );

//       return { 
//         creditsUsed: creditsRequired, 
//         remainingCredits: remainingCredits - creditsRequired 
//       };
//     } catch (error) {
//       throw error;
//     } 
//   }

//   // Get usage statistics for a user
//   static async getUserUsageStats(userId) {
//     const usages = await Usage.find({ userId });
//     const totalCost = usages.reduce((sum, usage) => sum + (usage.details.cost || 0), 0);
//     const totalCreditsUsed = this.dollarsToCredits(totalCost);
    
//     return {
//       totalUsages: usages.length,
//       totalCost,
//       totalCreditsUsed,
//       usagesByOperation: await Usage.aggregate([
//         { $match: { userId } },
//         { $group: {
//           _id: '$operation',
//           count: { $sum: 1 },
//           totalCost: { $sum: '$details.cost' }
//         }}
//       ])
//     };
//   }
// }

// const OpenAIUsageController = {
//   // Get all usages
//   getAllUsages: async (req, res) => {
//     try {
//       const usages = await Usage.find();
//       res.json(usages);
//     } catch (error) {
//       res.status(500).json({ error: 'Failed to fetch usages' });
//     }
//   },

//   // Get usage by ID
//   getUsageById: async (req, res) => {
//     try {
//       const usage = await Usage.findById(req.params.id);
//       if (!usage) {
//         return res.status(404).json({ error: 'Usage not found' });
//       }
//       res.json(usage);
//     } catch (error) {
//       res.status(500).json({ error: 'Failed to fetch usage' });
//     }
//   },

//   // Get user usage statistics
//   getUserStats: async (req, res) => {
//     try {
//       const stats = await UsageController.getUserUsageStats(req.params.userId);
//       res.json(stats);
//     } catch (error) {
//       res.status(500).json({ error: 'Failed to fetch usage statistics' });
//     }
//   },

//   // Record new usage
//   recordUsage: async (userId, operation, details ) => {
//     try {
//       const result = await UsageController.recordUsage(userId, operation, details);
//       return result;
//     } catch (error) {
//       return error;
//     }
//   },

//   recordUsageOfChat: async (userId, cost) => {
//     try {
//       const result = await UsageController.recordUsageOfChat(userId, cost);
//       return result;
//     } catch (error) {
//       throw error;
//     }
//   },

//   checkUserCredits: async (userId, cost) => {
//     try {
//       const result = await UsageController.dollarsToCredits(cost);
//       // await UsageController.recordUsageOfChat(userId, cost);
//       return result;
//     } catch (error) {
//       throw error;
//     }
//   }
// };

// module.exports = OpenAIUsageController;

const Usage = require('../models/UsageSchema');
const Client = require('../models/Client');
const UnifiedPricingService = require('../services/UnifiedPricingService');

// Initialize the pricing service
const pricingService = new UnifiedPricingService();

class UsageController {
  // All pricing calculations now delegated to UnifiedPricingService
  static dollarsToCredits(dollarAmount) {
    return pricingService.dollarsToCredits(dollarAmount);
  }

  // Calculate cost based on tokens and vector operations
  static calculateCost(inputTokens = 0, outputTokens = 0, vectorCount = 0) {
    return pricingService.calculateTotalCost({
      inputTokens,
      outputTokens,
      vectorCount
    }).totalCost;
  }

  // Record usage and update client credits
  static async recordUsage(userId, operation, details) {  
    try {
      // Calculate cost in dollars using the unified service
      const costDetails = pricingService.calculateTotalCost({
        inputTokens: details.inputTokens || 0,
        outputTokens: details.outputTokens || 0,
        vectorCount: details.vectorCount || 0,
        embeddingTokens: details.totalTokens || 0,  // Support for embedding operations
        pineconeChunks: details.pineconeChunks || 0,
        pineconeQueries: details.pineconeQueries || 0
      });

      // Get total cost
      const cost = costDetails.totalCost;

      // Convert to credits
      const creditsRequired = pricingService.dollarsToCredits(cost);

      // Check if client has enough credits
      const client = await Client.findOne({ userId });
      if (!client) {
        throw new Error('Client not found');
      }

      const remainingCredits = client.credits.total - client.credits.used;
      if (remainingCredits < creditsRequired) {
        throw new Error('Insufficient credits');
      }

      // Record usage with detailed cost breakdown
      const usage = new Usage({
        userId,
        operation,
        details: {
          ...details,
          cost,
          costBreakdown: costDetails // Store detailed cost breakdown
        },
      });
      await usage.save();

      // Update client credits
      await Client.findOneAndUpdate(
        { userId },
        { $inc: { 'credits.used': creditsRequired } }
      );

      return { 
        success: true,
        usage, 
        creditsUsed: creditsRequired, 
        remainingCredits: remainingCredits - creditsRequired 
      };
    } catch (error) {
      console.error(`Error recording usage: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  static async recordUsageOfChat(userId, cost) {  
    try {
      // Convert to credits using the unified service
      const creditsRequired = pricingService.dollarsToCredits(cost);

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
        { $inc: { 'credits.used': creditsRequired } }
      );

      return { 
        success: true,
        creditsUsed: creditsRequired, 
        remainingCredits: remainingCredits - creditsRequired 
      };
    } catch (error) {
      console.error(`Error recording chat usage: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    } 
  }

  // Get usage statistics for a user
  static async getUserUsageStats(userId) {
    const usages = await Usage.find({ userId });
    const totalCost = usages.reduce((sum, usage) => sum + (usage.details.cost || 0), 0);
    const totalCreditsUsed = pricingService.dollarsToCredits(totalCost);
    
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

const OpenAIUsageController = {
  // Get all usages
  getAllUsages: async (req, res) => {
    try {
      const usages = await Usage.find();
      res.json(usages);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usages' });
    }
  },

  // Get usage by ID
  getUsageById: async (req, res) => {
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
  getUserStats: async (req, res) => {
    try {
      const stats = await UsageController.getUserUsageStats(req.params.userId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usage statistics' });
    }
  },

  // Record new usage
  recordUsage: async (userId, operation, details) => {
    return await UsageController.recordUsage(userId, operation, details);
  },

  recordUsageOfChat: async (userId, cost) => {
    return await UsageController.recordUsageOfChat(userId, cost);
  },

  checkUserCredits: async (userId, cost) => {
    try {
      // Calculate credits required
      const creditsRequired = pricingService.dollarsToCredits(cost);
      
      // Check if client has enough credits
      const client = await Client.findOne({ userId });
      if (!client) {
        return false;
      }
      
      const remainingCredits = client.credits.total - client.credits.used;
      return remainingCredits >= creditsRequired;
    } catch (error) {
      console.error(`Error checking user credits: ${error.message}`);
      return false;
    }
  }
};

module.exports = OpenAIUsageController;