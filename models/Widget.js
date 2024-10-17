const mongoose = require("mongoose");
const { Schema } = mongoose;

const widgetSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'User'
    },
    widgetToken: {
      type: String,
      required: true,
      unique: true,
    },
    website: {
      type: String,
    },
    organisation: {
      type: String,
    },
    fallbackMessage: {
      type: String,
    },
    email: {
      type: String,
    },
    phone: {
      type: String,
    },
    isActive: {
      type: Number,
      default:1,//1=active,0=inactive
    },
  },
  { timestamps: true }
);


const Widget = mongoose.model("Widget", widgetSchema);
module.exports = Widget;
