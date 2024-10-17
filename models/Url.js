const mongoose = require("mongoose");
//unique: true
const urlSchema = new mongoose.Schema({
  sitemapId: { type: mongoose.Schema.Types.ObjectId, ref: "Sitemap" },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  url: { type: String },
  status: { type: String, default: "pending" },
  content: { type: String },
});

const Url = mongoose.model("Url", urlSchema);

module.exports = Url;
