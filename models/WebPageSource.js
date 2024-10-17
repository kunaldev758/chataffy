const mongoose = require("mongoose");
const webPageSourceSchema = new mongoose.Schema({
  webPageId: { type: mongoose.Schema.Types.ObjectId, ref: "WebPage" },
  sourceCode: { type: String },
},
{ timestamps: true });
const WebPageSource = mongoose.model("WebPageSource", webPageSourceSchema);
module.exports = WebPageSource;
