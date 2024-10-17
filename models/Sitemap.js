const mongoose = require('mongoose');
const sitemapSchema = new mongoose.Schema({
  url: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true , ref: 'User'},
  status: { type: Number, default: 0 }, // 0-Pending, 1-Success
  parentSitemapIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Sitemap' }],
},
{ timestamps: true });
const Sitemap = mongoose.model('Sitemap', sitemapSchema);
module.exports = Sitemap;
