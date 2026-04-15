const mongoose = require('mongoose');
const { Schema } = mongoose;

const chatTranscriptSettingSchema = new Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'User',
        unique: true,
    },
    transcriptEmails: {
        type: [String],
        required: true
    },
    salesLeadEmails: {
        type: [String],
        required: true
    },
    supportTicketEmails: {
        type: [String],
        required: true
    },
    salesLeadPhone: {
        type: String,
    },
    supportTicketPhone: {
        type: String,
    },
}, { timestamps: true });

const ChatTranscriptSetting = mongoose.model('ChatTranscriptSetting', chatTranscriptSettingSchema);

module.exports = ChatTranscriptSetting;