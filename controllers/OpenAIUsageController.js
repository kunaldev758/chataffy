const OpenAIUsage = require('../models/OpenAIUsage');

const OpenAIUsageController = {};

// Get all Open AI Usages
OpenAIUsageController.getAllOpenAIUsages = async (req, res) => {
  try {
    const openai_usages = await OpenAIUsage.find();
    res.json(openai_usages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Open AI Usages' });
  }
};

// Get a single Open AI Usage by ID
OpenAIUsageController.getOpenAIUsageById = async (req, res) => {
  const { id } = req.params;
  try {
    const openai_usage = await OpenAIUsage.findById(id);
    if (!openai_usage) {
      return res.status(404).json({ error: 'Open AI Usage not found' });
    }
    res.json(openai_usage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Open AI Usage' });
  }
};

// Create a new Open AI Usage
const createOpenAIUsage = async (request, response, type) => {
    let prompt_tokens = response.usage.prompt_tokens ?? 0;
    let completion_tokens = response.usage.completion_tokens ?? 0;
    // let total_tokens = response.usage.total_tokens ?? 0;
    let tokens_1K_cost_for_input, tokens_1K_cost_for_output, input_cost, output_cost, total_cost;
    switch(type)
    {
        case "Embedding Ada v2":
        case "text-embedding-3-small":
            tokens_1K_cost_for_input = 0.00002; //0.0001;
            tokens_1K_cost_for_output = 0;
            input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
            output_cost = 0;
            total_cost = input_cost+output_cost;
        break;
        // case "GPT-3.5 Turbo 4K":
        //     tokens_1K_cost_for_input = 0.0015;
        //     tokens_1K_cost_for_output = 0.002;
        //     input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
        //     output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
        //     total_cost = input_cost+output_cost;
        // break;
        // case "GPT-3.5 Turbo 16K":
        //     tokens_1K_cost_for_input = 0.003;
        //     tokens_1K_cost_for_output = 0.004;
        //     input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
        //     output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
        //     total_cost = input_cost+output_cost;
        // break;
        case "GPT-3.5 Turbo 4K":
        case "GPT-3.5 Turbo 16K":
        case "GPT-3.5 Turbo 1106 (16K)":
        case "GPT-3.5 Turbo":
          tokens_1K_cost_for_input = 0.0005;
          tokens_1K_cost_for_output = 0.0015;
          // type = "GPT-3.5 Turbo 1106 (16K)";
          type = "GPT-3.5 Turbo 0125";
          input_cost = (prompt_tokens*tokens_1K_cost_for_input)/1000;
          output_cost = (completion_tokens*tokens_1K_cost_for_output)/1000;
          total_cost = input_cost+output_cost;
        break;
    }
    
    try {
      const openai_usage = new OpenAIUsage({ request, response, type, tokens_1K_cost_for_input, tokens_1K_cost_for_output, input_cost, output_cost, total_cost });
      await openai_usage.save();
      return openai_usage;
    } catch (error) {
      throw error;
    }
};
OpenAIUsageController.createOpenAIUsage = createOpenAIUsage;
OpenAIUsageController.createOpenAIUsageAPI = async (req, res) => {
  const { request, response, type } = req.body;
  try {
    const openai_usage = await createOpenAIUsage(request, response, type);
    res.status(201).json(openai_usage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create Open AI Usage' });
  }
};

// Update an existing Open AI Usage by ID
OpenAIUsageController.updateOpenAIUsageById = async (req, res) => {
  const { id } = req.params;
  const { request, response, prompt_tokens, completion_tokens, total_tokens, tokens_1K_cost_for_prompt, tokens_1K_cost_for_completion, prompt_tokens_cost, completion_tokens_cost, total_cost } = req.body;
  try {
    const openai_usage = await OpenAIUsage.findByIdAndUpdate(
      id,
      { request, response, prompt_tokens, completion_tokens, total_tokens, tokens_1K_cost_for_prompt, tokens_1K_cost_for_completion, prompt_tokens_cost, completion_tokens_cost, total_cost },
      { new: true }
    );
    if (!openai_usage) {
      return res.status(404).json({ error: 'Open AI Usage not found' });
    }
    res.json(openai_usage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update Open AI Usage' });
  }
};

// Delete an existing Open AI Usage by ID
OpenAIUsageController.deleteOpenAIUsageById = async (req, res) => {
  const { id } = req.params;
  try {
    const openai_usage = await OpenAIUsage.findByIdAndDelete(id);
    if (!openai_usage) {
      return res.status(404).json({ error: 'Open AI Usage not found' });
    }
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete Open AI Usage' });
  }
};

const sumTotalCost = async() => {
  try {
    const usageDocuments = await OpenAIUsage.find({
      // 'createdAt': {
      //   $gt: new Date('2024-03-15T12:06:12.648+00:00'),
      //   $lte: new Date('2024-03-15T12:33:52.866+00:00')
      //   // $gte: new Date("2024-03-15T11:48:39.605+00:00"),
      //   // $lte: new Date("2024-03-15T12:04:47.630+00:00")
      // }
    }, 'total_cost');
    let totalCostSum = 0;
    usageDocuments.forEach((usage) => {
      totalCostSum += usage.total_cost;
    });
    return totalCostSum;
  } catch (error) {
    console.error('Error while calculating the sum:', error);
    throw error;
  }
};
OpenAIUsageController.sumTotalCost = async (req, res) => {  
  try {
    const totalCostSum = await sumTotalCost();
    res.status(200).json(totalCostSum);
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate the total cost.' });
  }
};

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

module.exports = OpenAIUsageController;