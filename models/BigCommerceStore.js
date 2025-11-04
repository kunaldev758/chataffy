// models/BigCommerceStore.js
const mongoose = require('mongoose');

const BigCommerceStoreSchema = new mongoose.Schema({
    store_hash: { type: String, required: true, unique: true },
    access_token: { type: String, required: true },
    scope: { type: String, required: true },
    context: { type: String },
    installed_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BigCommerceStore', BigCommerceStoreSchema);
