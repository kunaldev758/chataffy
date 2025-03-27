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
    logo: {
      type: String,
    },
    titleBar: { 
      type: String,
      default: "Organisation name",
    },
    welcomeMessage: {
      type: String,
      default: "Hello",
    },
    showLogo: {
      type: Boolean,
      default: true,
    },
    isPreChatFormEnabled: {
      type: Boolean,
      default: true,
    },
    fields: [
      {
        id: { type: Number, required: true },
        name: { type: String, required: true },
        value: { type: String, required: true },
        required: { type: Boolean, required: true },
      }
    ],
    colorFields: [
      {
        id: { type: Number, required: true },
        name: { type: String, required: true },
        value: { type: String, required: true },
      }
    ],
    isActive: {
      type: Number,
      default:1,//1=active,0=inactive
    },
  },
  { timestamps: true }
);


const Widget = mongoose.model("Widget", widgetSchema);
module.exports = Widget;
