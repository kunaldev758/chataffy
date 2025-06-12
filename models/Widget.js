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
      default: "Support Chat",
    },
    welcomeMessage: {
      type: String,
      default: "👋 Hi there! How can I help?",
    },
    showLogo: {
      type: Boolean,
      default: true,
    },
    showWhiteLabel: {
      type: Boolean,
      default: false,
    },
    isPreChatFormEnabled: {
      type: Boolean,
      default: true,
    },
    // Enhanced fields with type and placeholder support
    fields: [
      {
        id: { type: Number, required: true },
        name: { type: String, required: true },
        value: { type: String, required: true }, // Field label/name
        type: { 
          type: String, 
          required: true,
          enum: ['text', 'email', 'tel', 'number', 'url', 'textarea'],
          default: 'text'
        },
        placeholder: { type: String, default: '' },
        required: { type: Boolean, required: true },
        validation: {
          minLength: { type: Number, default: 0 },
          maxLength: { type: Number, default: 255 },
          pattern: { type: String, default: '' } // Regex pattern for validation
        }
      }
    ],
    colorFields: [
      {
        id: { type: Number, required: true },
        name: { type: String, required: true },
        value: { type: String, required: true },
      }
    ],
    // Widget positioning settings
    position: {
      align: {
        type: String,
        enum: ['left', 'right'],
        default: 'right'
      },
      sideSpacing: {
        type: Number,
        default: 20,
        min: 0,
        max: 200
      },
      bottomSpacing: {
        type: Number,
        default: 20,
        min: 0,
        max: 200
      }
    },
    // Advanced settings
    settings: {
      allowFileUpload: {
        type: Boolean,
        default: false
      },
      maxFileSize: {
        type: Number,
        default: 5 // MB
      },
      allowedFileTypes: {
        type: [String],
        default: ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx']
      },
      autoResponse: {
        enabled: { type: Boolean, default: true },
        delay: { type: Number, default: 1000 } // milliseconds
      },
      workingHours: {
        enabled: { type: Boolean, default: false },
        timezone: { type: String, default: 'UTC' },
        schedule: {
          monday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: true } 
          },
          tuesday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: true } 
          },
          wednesday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: true } 
          },
          thursday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: true } 
          },
          friday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: true } 
          },
          saturday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: false } 
          },
          sunday: { 
            start: { type: String, default: '09:00' }, 
            end: { type: String, default: '17:00' }, 
            enabled: { type: Boolean, default: false } 
          }
        }
      }
    },
    isActive: {
      type: Number,
      default: 1, // 1=active, 0=inactive
    },
  },
  { timestamps: true }
);

// Pre-save middleware to ensure default fields exist
widgetSchema.pre('save', function(next) {
  // Ensure default color fields exist
  if (!this.colorFields || this.colorFields.length === 0) {
    this.colorFields = [
      { id: 1, name: 'title_bar', value: '#000000' },
      { id: 2, name: 'title_bar_text', value: '#FFFFFF' },
      { id: 3, name: 'visitor_bubble', value: '#000000' },
      { id: 4, name: 'visitor_bubble_text', value: '#FFFFFF' },
      { id: 5, name: 'ai_bubble', value: '#000000' },
      { id: 6, name: 'ai_bubble_text', value: '#FFFFFF' },
    ];
  }

  // Ensure default pre-chat fields exist
  if (!this.fields || this.fields.length === 0) {
    this.fields = [
      { 
        id: 1, 
        name: 'Name', 
        value: 'Name',
        type: 'text',
        placeholder: 'Enter your name',
        required: true,
        validation: { minLength: 2, maxLength: 50 }
      },
      { 
        id: 2, 
        name: 'Email', 
        value: 'Email',
        type: 'email',
        placeholder: 'Enter your email',
        required: true,
        validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }
      },
      { 
        id: 3, 
        name: 'Phone', 
        value: 'Phone',
        type: 'tel',
        placeholder: 'Enter your phone number',
        required: false,
        validation: { minLength: 10, maxLength: 15 }
      },
    ];
  }

  // Ensure position defaults exist
  if (!this.position) {
    this.position = {
      align: 'right',
      sideSpacing: 20,
      bottomSpacing: 20
    };
  }

  next();
});

// Instance methods
widgetSchema.methods.isWithinWorkingHours = function() {
  if (!this.settings.workingHours.enabled) return true;
  
  const now = new Date();
  const dayName = now.toLocaleLowerCase('en-US', { weekday: 'long' });
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
  
  const todaySchedule = this.settings.workingHours.schedule[dayName];
  if (!todaySchedule.enabled) return false;
  
  return currentTime >= todaySchedule.start && currentTime <= todaySchedule.end;
};

widgetSchema.methods.validatePreChatData = function(formData) {
  const errors = [];
  
  this.fields.forEach(field => {
    const value = formData[field.name];
    
    // Check required fields
    if (field.required && (!value || value.trim() === '')) {
      errors.push(`${field.value} is required`);
      return;
    }
    
    if (value) {
      // Type-specific validation
      switch (field.type) {
        case 'email':
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(value)) {
            errors.push(`${field.value} must be a valid email address`);
          }
          break;
          
        case 'tel':
          const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
          if (!phoneRegex.test(value.replace(/[\s\-\(\)]/g, ''))) {
            errors.push(`${field.value} must be a valid phone number`);
          }
          break;
          
        case 'number':
          if (isNaN(value)) {
            errors.push(`${field.value} must be a number`);
          }
          break;
          
        case 'url':
          try {
            new URL(value);
          } catch {
            errors.push(`${field.value} must be a valid URL`);
          }
          break;
      }
      
      // Length validation
      if (field.validation.minLength && value.length < field.validation.minLength) {
        errors.push(`${field.value} must be at least ${field.validation.minLength} characters`);
      }
      
      if (field.validation.maxLength && value.length > field.validation.maxLength) {
        errors.push(`${field.value} must not exceed ${field.validation.maxLength} characters`);
      }
      
      // Pattern validation
      if (field.validation.pattern) {
        const regex = new RegExp(field.validation.pattern);
        if (!regex.test(value)) {
          errors.push(`${field.value} format is invalid`);
        }
      }
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// Static methods
widgetSchema.statics.getPublicSettings = function(widgetId) {
  return this.findById(widgetId).select(
    'titleBar welcomeMessage showLogo logo fields colorFields position showWhiteLabel isPreChatFormEnabled settings.allowFileUpload settings.maxFileSize settings.allowedFileTypes'
  );
};

const Widget = mongoose.model("Widget", widgetSchema);
module.exports = Widget;