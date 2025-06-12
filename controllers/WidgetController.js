const commonHelper = require("../helpers/commonHelper.js");
const Widget = require('../models/Widget');
const ObjectId = require('mongoose').Types.ObjectId;
const path = require('path');
const fs = require('fs');

const WidgetController = {};

// File validation helper
const validateFile = (file, allowedTypes = ['jpg', 'jpeg', 'png'], maxSize = 5 * 1024 * 1024) => {
  const errors = [];
  
  if (!file) {
    errors.push('No file provided');
    return { isValid: false, errors };
  }
  
  // Check file type
  const fileExtension = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (!allowedTypes.includes(fileExtension)) {
    errors.push(`File type .${fileExtension} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
  }
  
  // Check file size
  if (file.size > maxSize) {
    const maxSizeMB = maxSize / (1024 * 1024);
    errors.push(`File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds maximum allowed size of ${maxSizeMB}MB`);
  }
  
  // Check if file is actually an image (for image uploads)
  if (['jpg', 'jpeg', 'png', 'gif'].includes(fileExtension)) {
    const validMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (!validMimeTypes.includes(file.mimetype)) {
      errors.push('File does not appear to be a valid image');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    fileInfo: {
      originalName: file.originalname,
      size: file.size,
      type: fileExtension,
      mimeType: file.mimetype
    }
  };
};

WidgetController.getWidgetToken = async (req, res) => {
  try {
    const userId = req.body.userId;
    if (userId) {
      const widget = await Widget.findOne({ userId });
      if (widget) {
        res.status(200).json({ 
          status_code: 200, 
          data: { widgetId: widget._id, widgetToken: widget.widgetToken }
        });
      } else {
        res.status(404).json({ 
          status_code: 404, 
          message: "Widget not found for this user" 
        });
      }
    } else {
      res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

WidgetController.setBasicInfo = async (req, res) => {
  try {
    const { userId, basicInfo } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
    
    // Validate basic info fields
    const allowedFields = ['website', 'organisation', 'fallbackMessage', 'email', 'phone'];
    const updateData = {};
    
    Object.keys(basicInfo).forEach(key => {
      if (allowedFields.includes(key)) {
        updateData[key] = basicInfo[key];
      }
    });
    
    const updatedWidget = await Widget.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true }
    );
    
    if (updatedWidget) {
      res.status(200).json({ 
        status_code: 200, 
        message: "Basic information saved successfully",
        data: updateData
      });
    } else {
      res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found for this user" 
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

WidgetController.getBasicInfo = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
    
    const widget = await Widget.findOne({ userId });
    
    if (widget) {
      res.status(200).json({ 
        status_code: 200, 
        data: {
          website: widget.website,
          organisation: widget.organisation,
          fallbackMessage: widget.fallbackMessage,
          email: widget.email,
          phone: widget.phone,
        }
      });
    } else {
      res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found for this user" 
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

WidgetController.getThemeSettings = async (req, res) => {
  try {
    const userId = req.body.userId || req.params.userId;
    const widgetId = req.body.widgetId;
    
    let widget;
    
    if (userId) {
      widget = await Widget.findOne({ userId: userId });
    } else if (widgetId) {
      widget = await Widget.findOne({ _id: widgetId });
    } else {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId or WidgetId is required" 
      });
    }
    
    if (widget) {
      res.status(200).json({ 
        status_code: 200, 
        data: {
          logo: widget.logo,
          titleBar: widget.titleBar,
          welcomeMessage: widget.welcomeMessage,
          showLogo: widget.showLogo,
          showWhiteLabel: widget.showWhiteLabel,
          isPreChatFormEnabled: widget.isPreChatFormEnabled,
          fields: widget.fields,
          colorFields: widget.colorFields,
          position: widget.position,
          settings: widget.settings
        }
      });
    } else {
      res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found" 
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

WidgetController.updateThemeSettings = async (req, res) => {
  try {
    const { userId } = req.body;
    const themeSettings = req.body?.themeSettings.themeSettings;
    
    if (!userId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
    
    if (!themeSettings) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "Theme settings are required" 
      });
    }
    
    const widget = await Widget.findOne({ userId });
    
    if (!widget) {
      return res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found for this user" 
      });
    }
    
    // Validate and prepare update data
    const updateData = {};
    
    // Basic theme settings
    if (themeSettings.titleBar !== undefined) updateData.titleBar = themeSettings.titleBar;
    if (themeSettings.welcomeMessage !== undefined) updateData.welcomeMessage = themeSettings.welcomeMessage;
    if (themeSettings.showLogo !== undefined) updateData.showLogo = themeSettings.showLogo;
    if (themeSettings.showWhiteLabel !== undefined) updateData.showWhiteLabel = themeSettings.showWhiteLabel;
    if (themeSettings.isPreChatFormEnabled !== undefined) updateData.isPreChatFormEnabled = themeSettings.isPreChatFormEnabled;
    
    // Validate and update fields
    if (themeSettings.fields && Array.isArray(themeSettings.fields)) {
      const validatedFields = themeSettings.fields.map(field => {
        const validTypes = ['text', 'email', 'tel', 'number', 'url', 'textarea'];
        return {
          id: field.id || Date.now(),
          name: field.name || '',
          value: field.value || field.name || '',
          type: validTypes.includes(field.type) ? field.type : 'text',
          placeholder: field.placeholder || '',
          required: Boolean(field.required),
          validation: {
            minLength: field.validation?.minLength || 0,
            maxLength: field.validation?.maxLength || 255,
            pattern: field.validation?.pattern || ''
          }
        };
      });
      updateData.fields = validatedFields;
    }
    
    // Update color fields
    if (themeSettings.colorFields && Array.isArray(themeSettings.colorFields)) {
      updateData.colorFields = themeSettings.colorFields;
    }
    
    // Update position settings
    if (themeSettings.position) {
      updateData.position = {
        align: ['left', 'right'].includes(themeSettings.position.align) ? themeSettings.position.align : 'right',
        sideSpacing: Math.max(0, Math.min(200, themeSettings.position.sideSpacing || 20)),
        bottomSpacing: Math.max(0, Math.min(200, themeSettings.position.bottomSpacing || 20))
      };
    }
    
    // Update advanced settings
    if (themeSettings.settings) {
      updateData.settings = { ...widget.settings.toObject(), ...themeSettings.settings };
    }
    
    const updatedWidget = await Widget.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true }
    );
    
    res.status(200).json({ 
      status_code: 200, 
      message: "Theme settings updated successfully",
      data: {
        logo: updatedWidget.logo,
        titleBar: updatedWidget.titleBar,
        welcomeMessage: updatedWidget.welcomeMessage,
        showLogo: updatedWidget.showLogo,
        showWhiteLabel: updatedWidget.showWhiteLabel,
        isPreChatFormEnabled: updatedWidget.isPreChatFormEnabled,
        fields: updatedWidget.fields,
        colorFields: updatedWidget.colorFields,
        position: updatedWidget.position,
        settings: updatedWidget.settings
      }
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

WidgetController.uploadLogo = async (req, res) => {
  try {
    const userId  = req.params.userId;
    
    if (!userId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
    
    // Validate file
    const validation = validateFile(req.file, ['jpg', 'jpeg', 'png'], 5 * 1024 * 1024);
    
    if (!validation.isValid) {
      // Delete uploaded file if validation fails
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (deleteError) {
          console.error('Error deleting invalid file:', deleteError);
        }
      }
      
      return res.status(400).json({ 
        status_code: 400, 
        message: "File validation failed",
        errors: validation.errors
      });
    }
    
    const widget = await Widget.findOne({ userId });
    
    if (!widget) {
      // Delete uploaded file if widget not found
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (deleteError) {
          console.error('Error deleting file:', deleteError);
        }
      }
      
      return res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found for this user" 
      });
    }
    
    // Delete old logo if exists
    if (widget.logo) {
      const oldLogoPath = path.join(__dirname, '..', widget.logo);
      try {
        if (fs.existsSync(oldLogoPath)) {
          fs.unlinkSync(oldLogoPath);
        }
      } catch (deleteError) {
        console.error('Error deleting old logo:', deleteError);
      }
    }
    
    const filePath = `/uploads/${req.file.filename}`;
    
    const updatedWidget = await Widget.findOneAndUpdate(
      { userId: userId },
      { logo: filePath },
      { new: true }
    );
    
    res.status(200).json({ 
      status_code: 200,
      message: 'Logo uploaded successfully', 
      data: {
        filePath,
        fileInfo: validation.fileInfo
      }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (deleteError) {
        console.error('Error deleting file on error:', deleteError);
      }
    }
    
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

// New endpoint for validating pre-chat form data
WidgetController.validatePreChatForm = async (req, res) => {
  try {
    const { widgetId, formData } = req.body;
    
    if (!widgetId || !formData) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "WidgetId and formData are required" 
      });
    }
    
    const widget = await Widget.findById(widgetId);
    
    if (!widget) {
      return res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found" 
      });
    }
    
    const validation = widget.validatePreChatData(formData);
    
    if (validation.isValid) {
      res.status(200).json({ 
        status_code: 200, 
        message: "Form data is valid",
        data: { isValid: true }
      });
    } else {
      res.status(400).json({ 
        status_code: 400, 
        message: "Form validation failed",
        data: { 
          isValid: false, 
          errors: validation.errors 
        }
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

// Get public widget settings (for widget display)
WidgetController.getPublicWidgetSettings = async (req, res) => {
  try {
    const { widgetId, widgetToken } = req.params;
    
    if (!widgetId || !widgetToken) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "WidgetId and widgetToken are required" 
      });
    }
    
    const widget = await Widget.getPublicSettings(widgetId);
    
    if (!widget || widget.widgetToken !== widgetToken) {
      return res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found or invalid token" 
      });
    }
    
    res.status(200).json({ 
      status_code: 200, 
      data: widget
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

// Update widget position
WidgetController.updateWidgetPosition = async (req, res) => {
  try {
    const { userId, position } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "UserId is required" 
      });
    }
    
    if (!position) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "Position data is required" 
      });
    }
    
    const updateData = {
      'position.align': ['left', 'right'].includes(position.align) ? position.align : 'right',
      'position.sideSpacing': Math.max(0, Math.min(200, position.sideSpacing || 20)),
      'position.bottomSpacing': Math.max(0, Math.min(200, position.bottomSpacing || 20))
    };
    
    const updatedWidget = await Widget.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true }
    );
    
    if (updatedWidget) {
      res.status(200).json({ 
        status_code: 200, 
        message: "Widget position updated successfully",
        data: { position: updatedWidget.position }
      });
    } else {
      res.status(404).json({ 
        status_code: 404, 
        message: "Widget not found for this user" 
      });
    }
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ 
      status: false, 
      message: "Something went wrong please try again!" 
    });
  }
};

module.exports = WidgetController;