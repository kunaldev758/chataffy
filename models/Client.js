const mongoose = require("mongoose");
const clientSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  credits: {
    total: { type: Number, default: 10000 },
    used: { type: Number, default: 0 },
  },
  sitemapScrappingStatus: { type: Number, default: 0 }, // 0-NoCurrentScrapping, 1-RunningScrapping
  webPageScrappingStatus: { type: Number, default: 0 }, // 0-NoCurrentScrapping, 1-RunningScrapping
  webPageMappingCount: { type: Number, default: 0 },
},
{ timestamps: true });
const Client = mongoose.model("Client", clientSchema);
module.exports = Client;
