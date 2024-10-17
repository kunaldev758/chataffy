const mongoose = require('mongoose');

const openAIUsageSchema = new mongoose.Schema({
  request: {
    type: Object,
    required: true,
  },
  response: {
    type: Object,
    required: true,
  },
  type: {
    type: String,
    // enum: ['Embedding Ada v2', 'GPT-3.5 Turbo 4K', 'GPT-3.5 Turbo 16K', 'GPT-3.5 Turbo 1106 (16K)'],
    required: true,
  },
  tokens_1K_cost_for_input: {
    type: Number,
  },
  tokens_1K_cost_for_output: {
    type: Number,
  },
  input_cost: {
    type: Number,
  },
  output_cost: {
    type: Number,
  },
  total_cost: {
    type: Number,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
},
{ timestamps: true }
);

const OpenAIUsage = mongoose.model('OpenAIUsage', openAIUsageSchema);
module.exports = OpenAIUsage;
