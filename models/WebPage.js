const mongoose = require("mongoose");
const webPageSchema = new mongoose.Schema({
  trainingListId: { type: mongoose.Schema.Types.ObjectId, ref: "TrainingList" },
  url: { type: String },
  title: { type: String },
  metaDescription: { type: String },
  content: { type: String },
  sitemapIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Sitemap" }],
},
{ timestamps: true });
const WebPage = mongoose.model("WebPage", webPageSchema);
module.exports = WebPage;
