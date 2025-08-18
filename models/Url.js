const mongoose = require("mongoose");

const urlSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    trainStatus: {
        type: Number,
        enum: [0, 1, 2], // 0-untrained, 1-trained, 2-error
        default: 0
    },
    error: {
        type: String,
        default: null
    }
});

const Url = mongoose.model("Url", urlSchema);
module.exports = Url;