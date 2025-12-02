const mongoose = require("mongoose");
const { Schema } = mongoose;

const websiteDataSchema = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
      unique: true,
    },
    // Company Information
    company_name: {
      type: String,
      default: "",
    },
    company_type: {
      type: String,
      default: "", // e.g., "SaaS company", "e-commerce platform", "service provider"
    },
    industry: {
      type: String,
      default: "", // e.g., "technology", "healthcare", "real estate"
    },
    founded_year: {
      type: String,
      default: "", // Store as string to handle cases where year is not found
    },
    // Services and Offerings
    services_list: {
      type: [String],
      default: [], // Array of services/products
    },
    value_proposition: {
      type: String,
      default: "", // Core value proposition or mission statement
    },
    // What company does NOT do
    does_not_list: {
      type: [String],
      default: [], // Array of things the company explicitly does not do
    },
    // Additional metadata
    website_url: {
      type: String,
      default: "",
    },
    domain: {
      type: String,
      default: "",
    },
    // Metadata extraction status
    extraction_status: {
      type: String,
      enum: ["pending", "completed", "partial"],
      default: "pending",
    },
    // Last updated timestamp
    last_extracted_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Index for faster lookups
websiteDataSchema.index({ userId: 1 });

// Static method to get or create website data
websiteDataSchema.statics.getOrCreate = async function (userId) {
  let websiteData = await this.findOne({ userId });
  if (!websiteData) {
    websiteData = new this({ userId });
    await websiteData.save();
  }
  return websiteData;
};

// Method to update website data
websiteDataSchema.methods.updateData = async function (updates) {
  Object.assign(this, updates);
  this.last_extracted_at = new Date();
  if (updates.company_name || updates.services_list?.length > 0) {
    this.extraction_status = "completed";
  } else if (Object.keys(updates).length > 0) {
    this.extraction_status = "partial";
  }
  return this.save();
};

const WebsiteData = mongoose.model("WebsiteData", websiteDataSchema);
module.exports = WebsiteData;

