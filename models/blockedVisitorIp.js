const mongoose = require('mongoose');

const blockedVisitorIpSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // TTL index: document will be removed at this date
  }
}, { timestamps: true });

const BlockedVisitorIp = mongoose.model('BlockedVisitorIp', blockedVisitorIpSchema);

module.exports = BlockedVisitorIp;
