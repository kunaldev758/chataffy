// models/Plan.js
const mongoose = require("mongoose");

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ""
  },
  pricing: {
    monthly: {
      type: Number,
      default: 0
    },
    yearly: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: "USD"
    }
  },
  limits: {
    maxQueries: {
      type: Number,
      default: 1000 // queries per month
    },
    maxAgentsPerAccount: {
      type: Number,
      default: 1
    },
    maxStorage: {
      type: Number,
      default: 1024 * 1024 * 1024 // 1GB default
    }
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'deprecated'],
    default: 'active'
  },
  order: {
    type: Number,
    default: 0 // For ordering plans in UI
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  metadata: {
    color: String, // For UI theming
    icon: String,  // Icon name or URL
    popular: {
      type: Boolean,
      default: false
    },
    trial: {
      enabled: {
        type: Boolean,
        default: false
      },
      days: {
        type: Number,
        default: 7
      }
    }
  },
  createdBy: {
    type: String, // Super admin ID
    required: true
  },
  updatedBy: {
    type: String
  }
}, {
  timestamps: true
});

// Indexes
planSchema.index({ name: 1 });
planSchema.index({ status: 1 });
planSchema.index({ order: 1 });
planSchema.index({ isDefault: 1 });


planSchema.virtual('maxPages').get(function() {
  return this.limits.maxPages;
});


// Ensure virtuals are included in JSON output
planSchema.set('toJSON', { virtuals: true });
planSchema.set('toObject', { virtuals: true });

// Pre-save middleware to ensure only one default plan
planSchema.pre('save', async function(next) {
  if (this.isDefault && this.isModified('isDefault')) {
    // Remove default from all other plans
    await this.constructor.updateMany(
      { _id: { $ne: this._id } },
      { $set: { isDefault: false } }
    );
  }
  next();
});

// Static method to get default plan
planSchema.statics.getDefaultPlan = async function() {
  let defaultPlan = await this.findOne({ isDefault: true, status: 'active' });
  
  if (!defaultPlan) {
    // If no default plan is set, get the first active plan
    defaultPlan = await this.findOne({ status: 'active' }).sort({ order: 1 });
  }
  
  return defaultPlan;
};

// Static method to get plan by name
planSchema.statics.getPlanByName = async function(planName) {
  return await this.findOne({ 
    name: planName.toLowerCase(), 
    status: 'active' 
  });
};

// Static method to get all active plans
planSchema.statics.getActivePlans = async function() {
  return await this.find({ status: 'active' }).sort({ order: 1 });
};

module.exports = mongoose.model("Plan", planSchema);