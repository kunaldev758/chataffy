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
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      ref: "Agent",
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

function toObjectId(value) {
  if (value == null || value === "") return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(value);
}

// Static method: getOrCreate(userId) or getOrCreate({ userId, agentId? })
websiteDataSchema.statics.getOrCreate = async function (input) {
  const isOptsObject =
    input != null &&
    typeof input === "object" &&
    !(input instanceof mongoose.Types.ObjectId);

  const rawUserId = isOptsObject ? input.userId : input;
  const rawAgentId = isOptsObject && Object.prototype.hasOwnProperty.call(input, "agentId")
    ? input.agentId
    : undefined;

  const userId = toObjectId(rawUserId);
  if (!userId) {
    throw new Error("WebsiteData.getOrCreate: userId is required");
  }

  let websiteData = await this.findOne({ userId });
  if (!websiteData) {
    const doc = { userId };
    if (rawAgentId != null && rawAgentId !== "") {
      const aid = toObjectId(rawAgentId);
      if (aid) doc.agentId = aid;
    }
    websiteData = new this(doc);
    await websiteData.save();
    return websiteData;
  }

  if (rawAgentId != null && rawAgentId !== "") {
    const aid = toObjectId(rawAgentId);
    if (aid && (!websiteData.agentId || !websiteData.agentId.equals(aid))) {
      websiteData.agentId = aid;
      await websiteData.save();
    }
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

