// const OpenAIUsage = require('../models/OpenAIUsage');
// const Usage = require('../models/Usage');

// const OpenAIUsageController = {};

// // Get all Open AI Usages
// OpenAIUsageController.getAllOpenAIUsages = async (req, res) => {
//   try {
//     const openai_usages = await Usage.find();
//     res.json(openai_usages);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to fetch Open AI Usages' });
//   }
// };

// // Get a single Open AI Usage by ID
// OpenAIUsageController.getOpenAIUsageById = async (req, res) => {
//   const { id } = req.params;
//   try {
//     const openai_usage = await Usage.findById(id);
//     if (!openai_usage) {
//       return res.status(404).json({ error: 'Open AI Usage not found' });
//     }
//     res.json(openai_usage);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to fetch Open AI Usage' });
//   }
// };

// // Create a new Open AI Usage
// const createOpenAIUsage = async (request, response, type) => {
//     let prompt_tokens = response.usage.prompt_tokens ?? 0;
//     let completion_tokens = response.usage.completion_tokens ?? 0;
//     // let total_tokens = response.usage.total_tokens ?? 0;
//     let tokens_1K_cost_for_input, tokens_1K_cost_for_output, input_cost, output_cost, total_cost;
//     switch(type)
//     {
//         case "Embedding Ada v2":
//         case "text-embedding-3-small":
//             tokens_1K_cost_for_input = 0.00002; //0.0001;
//             tokens_1K_cost_for_output = 0;
//             input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
//             output_cost = 0;
//             total_cost = input_cost+output_cost;
//         break;
//         // case "GPT-3.5 Turbo 4K":
//         //     tokens_1K_cost_for_input = 0.0015;
//         //     tokens_1K_cost_for_output = 0.002;
//         //     input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
//         //     output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
//         //     total_cost = input_cost+output_cost;
//         // break;
//         // case "GPT-3.5 Turbo 16K":
//         //     tokens_1K_cost_for_input = 0.003;
//         //     tokens_1K_cost_for_output = 0.004;
//         //     input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
//         //     output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
//         //     total_cost = input_cost+output_cost;
//         // break;
//         case "GPT-3.5 Turbo 4K":
//         case "GPT-3.5 Turbo 16K":
//         case "GPT-3.5 Turbo 1106 (16K)":
//         case "GPT-3.5 Turbo":
//           tokens_1K_cost_for_input = 0.0005;
//           tokens_1K_cost_for_output = 0.0015;
//           // type = "GPT-3.5 Turbo 1106 (16K)";
//           type = "GPT-3.5 Turbo 0125";
//           input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
//           output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
//           total_cost = input_cost+output_cost;
//         break;
//     }
    
//     try {
//       const openai_usage = new OpenAIUsage({ request, response, type, tokens_1K_cost_for_input, tokens_1K_cost_for_output, input_cost, output_cost, total_cost });
//       await openai_usage.save();
//       return openai_usage;
//     } catch (error) {
//       throw error;
//     }
// };
// OpenAIUsageController.createOpenAIUsage = createOpenAIUsage;
// OpenAIUsageController.createOpenAIUsageAPI = async (req, res) => {
//   const { request, response, type } = req.body;
//   try {
//     const openai_usage = await createOpenAIUsage(request, response, type);
//     res.status(201).json(openai_usage);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to create Open AI Usage' });
//   }
// };

// // Update an existing Open AI Usage by ID
// OpenAIUsageController.updateOpenAIUsageById = async (req, res) => {
//   const { id } = req.params;
//   const { request, response, prompt_tokens, completion_tokens, total_tokens, tokens_1K_cost_for_prompt, tokens_1K_cost_for_completion, prompt_tokens_cost, completion_tokens_cost, total_cost } = req.body;
//   try {
//     const openai_usage = await OpenAIUsage.findByIdAndUpdate(
//       id,
//       { request, response, prompt_tokens, completion_tokens, total_tokens, tokens_1K_cost_for_prompt, tokens_1K_cost_for_completion, prompt_tokens_cost, completion_tokens_cost, total_cost },
//       { new: true }
//     );
//     if (!openai_usage) {
//       return res.status(404).json({ error: 'Open AI Usage not found' });
//     }
//     res.json(openai_usage);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to update Open AI Usage' });
//   }
// };

// // Delete an existing Open AI Usage by ID
// OpenAIUsageController.deleteOpenAIUsageById = async (req, res) => {
//   const { id } = req.params;
//   try {
//     const openai_usage = await OpenAIUsage.findByIdAndDelete(id);
//     if (!openai_usage) {
//       return res.status(404).json({ error: 'Open AI Usage not found' });
//     }
//     res.sendStatus(204);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to delete Open AI Usage' });
//   }
// };

// const sumTotalCost = async() => {
//   try {
//     const usageDocuments = await OpenAIUsage.find({
//       // 'createdAt': {
//       //   $gt: new Date('2024-03-15T12:06:12.648+00:00'),
//       //   $lte: new Date('2024-03-15T12:33:52.866+00:00')
//       //   // $gte: new Date("2024-03-15T11:48:39.605+00:00"),
//       //   // $lte: new Date("2024-03-15T12:04:47.630+00:00")
//       // }
//     }, 'total_cost');
//     let totalCostSum = 0;
//     usageDocuments.forEach((usage) => {
//       totalCostSum += usage.total_cost;
//     });
//     return totalCostSum;
//   } catch (error) {
//     console.error('Error while calculating the sum:', error);
//     throw error;
//   }
// };
// OpenAIUsageController.sumTotalCost = async (req, res) => {  
//   try {
//     const totalCostSum = await sumTotalCost();
//     res.status(200).json(totalCostSum);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to calculate the total cost.' });
//   }
// };

// const deletePreviousRecordsByDate = async(delete_before_date) => {
//   try {
//     const deleteBeforeDate = new Date(delete_before_date);
//     const deletedRecords = await OpenAIUsage.deleteMany({ createdAt: { $lt: deleteBeforeDate } });
//     return deletedRecords.deletedCount;
//   } catch (error) {
//     console.error('Error while deleting records:', error);
//     throw error;
//   }
// }
// OpenAIUsageController.deletePreviousRecordsByDate = async (req, res) => {  
//   const {delete_before_date} = req.body;
//   try {
//     const totalDeletedRecords = await deletePreviousRecordsByDate(delete_before_date);
//     res.status(200).json(totalDeletedRecords);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to delete records.' });
//   }
// };

// module.exports = OpenAIUsageController;


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
    const session = await Usage.startSession();
    try {
      session.startTransaction();

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
        { session, new: true }
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
        { session, new: true }
      );

      // await session.commitTransaction();
      return { usage, creditsUsed: creditsRequired, remainingCredits: remainingCredits - creditsRequired };
    } catch (error) {
      // await session.abortTransaction();
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
// const UsageRoutes = {
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