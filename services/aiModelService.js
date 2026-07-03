const { AiModelsCategory, AiModel } = require("../models/AiModel");

exports.getModelForCategory = async (category) => {
  try {
    let model = await AiModelsCategory.findOne({
      category: category,
    })
      .select("_id")
      .lean();

    if (!model) throw new Error(`No AI model category found for "${category}"`);

    const aiModal = await AiModel.findOne({
      status: "active",
      categories: model._id,
    }).lean();

    if (!aiModal)
      throw new Error(
        `No active AI model configured for category "${category}"`,
      );

    return aiModal;
  } catch (err) {
    console.error(`Error fetching model for category ${category}:`, err);
  }
};
