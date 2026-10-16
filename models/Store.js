const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'User',
        index: true,
    },
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'Client',
    },
    storeHash: {
        type: String,
        required: true,
        unique: true,
    },
    storeUrl: {
        type: String,
        default: '',
    },
    platform: {
        type: String,
        enum: ['bigcommerce', 'shopify'],
        default: 'bigcommerce',
    },
    accessToken: {
        type: String,
        default: null,
    },
    refreshToken: {
        type: String,
        default: null,
    },
    accessTokenExpiresAt: {
        type: Date,
        default: null,
    },
    refreshTokenExpiresAt: {
        type: Date,
        default: null,
    },
    email: {
        type: String,
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    scope: {
        type: String,
        required: true,
    },
    lastInstalledAt: {
        type: Date,
        default: null,
    },
    lastUninstalledAt: {
        type: Date,
        default: null,
    },
    status: {
        type: String,
        enum: ['uninstalled', 'installed'],
        default: null,
    },
    // Per-store onboarding state. Missing = legacy store (falls back to the
    // user-level isOnboarded flag); true/false = tracked per store.
    isOnboarded: {
        type: Boolean,
        default: undefined,
    },
}, {timestamps: true});

const Store = mongoose.model('Store', storeSchema);
module.exports = Store;