const mongoose = require("mongoose");

let visitorSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    }, // client
    name: { type: String, required: true },
    visitorId:{type:String},
    visitorDetails: [
      {
        field: {
          type: String, // Field name (e.g., "name", "email")
          required: true,
        },
        value: {
          type: String, // Field value
          required: true,
        },
      },
    ],
    ip: { type: String },
    location: { type: String },
    is_blocked: { type: Boolean, default: false },
    lastMessage: { type: String },
  },
  { timestamps: true }
);

const Visitor = mongoose.model("Visitor", visitorSchema);
module.exports = Visitor;
