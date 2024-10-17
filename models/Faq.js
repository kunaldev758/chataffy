const mongoose = require("mongoose");
const faqSchema = new mongoose.Schema({
  trainingListId: { type: mongoose.Schema.Types.ObjectId, ref: "TrainingList" },
  question: { type: String },
  answer: { type: String },
},
{ timestamps: true });
const Faq = mongoose.model("Faq", faqSchema);
module.exports = Faq;
