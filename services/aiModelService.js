const AiModel = require("../models/AiModel");

exports.getModelForCategory = async (category) => {
    let model = await AiModel.findOne({
      status: "active",
      categories: category,
    }).lean();
  
    if (!model) throw new Error(`No active AI model configured for category "${category}"`);
  
    return model;
}