const commonHelper = require("../helpers/commonHelper.js");
const Widget = require('../models/Widget');
const User = require('../models/User');
const Client = require('../models/Client');
const Agent = require('../models/Agent');
const WebsiteData = require('../models/WebsiteData');
const ObjectId = require('mongoose').Types.ObjectId;
const path = require('path');
const fs = require('fs');

const WidgetController = {};

/** Load widget doc + raw Mongo doc (for legacy `position` migration on read). */
async function getWidgetAndRawByQuery(query) {
  const widget = await Widget.findOne(query);
  if (!widget) return { widget: null, raw: null };
  const raw = await Widget.collection.findOne({ _id: widget._id });
  return { widget, raw };
}

function legacyAlignFromRaw(raw) {
  const a = raw?.position?.align;
  return a === 'left' || a === 'right' ? a : null;
}

/** Normalize a URL or hostname to a bare hostname (no www.), lowercase. */
function normalizeEmbedHost(input) {
  if (input == null || input === '') return '';
  const s = String(input).trim();
  if (!s || s === 'null') return '';
  try {
    const url = s.includes('://') ? new URL(s) : new URL(`https://${s}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    const stripped = s.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (!stripped) return '';
    return stripped.startsWith('www.') ? stripped.slice(4) : stripped;
  }
}

/** Treat localhost / 127.0.0.1 / ::1 as the same (Live Server vs bookmarked localhost). */
const LOOPBACK_EMBED_CANONICAL = '__loopback__';

function canonicalEmbedHost(input) {
  const h = normalizeEmbedHost(input);
  if (!h) return '';
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1'
  ) {
    return LOOPBACK_EMBED_CANONICAL;
  }
  return h;
}

/**
 * Canonical hosts for embed allow-list: theme website, agent URLs, scraped metadata.
 * FAQ/doc-only onboarding often leaves onboardingWebsiteUrl empty — extractedUrls may still hold the site.
 */
function collectEmbedHostsForWidget(w, agent, websiteRows) {
  const aid = w.agentId ? String(w.agentId) : '';
  const uid = w.userId ? String(w.userId) : '';
  /** @type {Set<string>} */
  const hosts = new Set();

  const add = (input) => {
    const c = canonicalEmbedHost(input);
    if (c) hosts.add(c);
  };

  if (w.website) add(w.website);

  if (agent) {
    if (agent.onboardingWebsiteUrl) add(agent.onboardingWebsiteUrl);
    if (Array.isArray(agent.onboardingExtractedUrls)) {
      for (let i = 0; i < agent.onboardingExtractedUrls.length; i++) {
        add(agent.onboardingExtractedUrls[i]);
      }
    }
    if (agent.website_name) add(agent.website_name);
  }

  for (let r = 0; r < websiteRows.length; r++) {
    const row = websiteRows[r];
    const rowAgent = row.agentId ? String(row.agentId) : '';
    const rowUser = row.userId ? String(row.userId) : '';
    if ((aid && rowAgent === aid) || (uid && rowUser === uid)) {
      if (row.website_url) add(row.website_url);
      if (row.domain) add(row.domain);
    }
  }

  return hosts;
}

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
    const agentId = req.body.agentId;
    if (agentId) {
      const widget = await Widget.findOne({ agentId });
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
        message: "AgentId is required" 
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
    const widgetId = req.body.widgetId || req.params.widgetId;
    const agentId = req.body.agentId || req.params.agentId;
    
    let widget;
    let raw = null;

    if (agentId) {
      const pair = await getWidgetAndRawByQuery({ agentId: agentId });
      widget = pair.widget;
      raw = pair.raw;
    } else if (widgetId) {
      const pair = await getWidgetAndRawByQuery({ _id: widgetId });
      widget = pair.widget;
      raw = pair.raw;
    } else {
      return res.status(400).json({ 
        status_code: 400, 
        message: "AgentId or WidgetId is required" 
      });
    }
    
    if (widget) {
      const align =
        widget.align || legacyAlignFromRaw(raw) || 'right';
      const widgetType =
        widget.widgetType === 'bar' || widget.widgetType === 'bubble'
          ? widget.widgetType
          : 'bubble';
      const displayBarMessage =
        widget.displayBarMessage != null && String(widget.displayBarMessage).trim() !== ''
          ? widget.displayBarMessage
          : "We're Online! Chat Now!";

      res.status(200).json({ 
        status_code: 200, 
        data: {
          widgetId: widget._id,
          logo: widget.logo,
          titleBar: widget.titleBar,
          welcomeMessage: widget.welcomeMessage,
          showLogo: widget.showLogo,
          showWhiteLabel: widget.showWhiteLabel,
          isPreChatFormEnabled: widget.isPreChatFormEnabled,
          fields: widget.fields,
          colorFields: widget.colorFields,
          align,
          widgetType,
          displayBarMessage,
          settings: widget.settings,
          widgetToken: widget.widgetToken,
          // website: widget.website,
          // organisation: widget.organisation,
          // fallbackMessage: widget.fallbackMessage,
          // email: widget.email || user?.email,
          // phone: widget.phone,
          // liveAgentSupport: widget?.liveAgentSupport ?? false,
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
    const { agentId } = req.body;
    const themeSettings = req.body.themeSettings;
    
    if (!agentId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "AgentId is required" 
      });
    }
    
    if (!themeSettings) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "Theme settings are required" 
      });
    }
    
    const widget = await Widget.findOne({ agentId });
    
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
    if (themeSettings.liveAgentSupport !== undefined) updateData.liveAgentSupport = themeSettings.liveAgentSupport;
    if (themeSettings.email !== undefined) updateData.email = themeSettings.email;
    if (themeSettings.phone !== undefined) updateData.phone = themeSettings.phone;
    if (themeSettings.website !== undefined) updateData.website = themeSettings.website;
    if (themeSettings.organisation !== undefined) updateData.organisation = themeSettings.organisation;
    if (themeSettings.fallbackMessage !== undefined) updateData.fallbackMessage = themeSettings.fallbackMessage;
    
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
    
    // Horizontal alignment (replaces legacy `position.align`)
    if (themeSettings.align !== undefined) {
      updateData.align = ['left', 'right'].includes(themeSettings.align)
        ? themeSettings.align
        : 'right';
    } else if (themeSettings.position && themeSettings.position.align !== undefined) {
      updateData.align = ['left', 'right'].includes(themeSettings.position.align)
        ? themeSettings.position.align
        : 'right';
    }

    if (themeSettings.widgetType !== undefined) {
      updateData.widgetType = ['bubble', 'bar'].includes(themeSettings.widgetType)
        ? themeSettings.widgetType
        : 'bubble';
    }

    if (themeSettings.displayBarMessage !== undefined) {
      const msg = String(themeSettings.displayBarMessage).trim();
      updateData.displayBarMessage = msg.slice(0, 200) || "We're Online! Chat Now!";
    }
    
    // Update advanced settings
    if (themeSettings.settings) {
      updateData.settings = { ...widget.settings.toObject(), ...themeSettings.settings };
    }
    
    const mongoUpdate = { $unset: { position: 1 } };
    if (Object.keys(updateData).length > 0) {
      mongoUpdate.$set = updateData;
    }

    const updatedWidget = await Widget.findOneAndUpdate(
      { agentId },
      mongoUpdate,
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
        align: updatedWidget.align,
        widgetType: updatedWidget.widgetType,
        displayBarMessage: updatedWidget.displayBarMessage,
        settings: updatedWidget.settings,
        website: updatedWidget.website,
        organisation: updatedWidget.organisation,
        fallbackMessage: updatedWidget.fallbackMessage,
        email: updatedWidget.email,
        phone: updatedWidget.phone,
        liveAgentSupport: updatedWidget.liveAgentSupport,
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
    const agentId  = req.params.agentId;
    
    if (!agentId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "AgentId is required" 
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
    
    const widget = await Widget.findOne({ agentId });
    
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
      { agentId: agentId },
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

/** GET /api/widget/embed?origin= — map parent page origin to widget credentials (short embed script). */
WidgetController.resolveEmbedByOrigin = async (req, res) => {
  try {
    const originParam = req.query.origin;
    const requestCanonical = canonicalEmbedHost(originParam);
    const narrowWid = req.query.wid ? String(req.query.wid).trim() : '';

    if (!requestCanonical) {
      return res.status(400).json({
        status_code: 400,
        message: 'origin is required (full URL of the page, e.g. https://shop.example)',
      });
    }

    const widgets = await Widget.find({ agentId: { $exists: true, $ne: null } })
      .select('_id widgetToken agentId website userId')
      .lean();

    const agentObjectIds = widgets.map((w) => w.agentId).filter(Boolean);
    const userObjectIds = widgets.map((w) => w.userId).filter(Boolean);

    const agents = await Agent.find({ _id: { $in: agentObjectIds } })
      .select('onboardingWebsiteUrl onboardingExtractedUrls website_name')
      .lean();
    const agentById = Object.fromEntries(agents.map((a) => [String(a._id), a]));

    const websiteRows = await WebsiteData.find({
      $or: [
        { agentId: { $in: agentObjectIds } },
        { userId: { $in: userObjectIds } },
      ],
    })
      .select('userId agentId website_url domain')
      .lean();

    /** @type {typeof widgets} */
    let matches = [];

    for (const w of widgets) {
      if (narrowWid && String(w._id) !== narrowWid) continue;
      const ag = agentById[w.agentId ? String(w.agentId) : ''];
      const hosts = collectEmbedHostsForWidget(w, ag, websiteRows);
      for (const h of hosts) {
        if (h && h === requestCanonical) {
          matches.push(w);
          break;
        }
      }
    }

    // Explicit ?wid= on loopback: always resolve (preview on Live Server / localhost even if training URL is production-only).
    if (
      matches.length === 0 &&
      narrowWid &&
      requestCanonical === LOOPBACK_EMBED_CANONICAL
    ) {
      const w = widgets.find((x) => String(x._id) === narrowWid);
      if (w) {
        matches = [w];
      }
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const allowLooseLoopback =
      process.env.WIDGET_EMBED_LOOPBACK_LOOSE === '1' || !isProduction;

    if (
      matches.length === 0 &&
      requestCanonical === LOOPBACK_EMBED_CANONICAL &&
      allowLooseLoopback
    ) {
      const candidates = widgets.filter((w) => {
        if (narrowWid && String(w._id) !== narrowWid) return false;
        const ag = agentById[w.agentId ? String(w.agentId) : ''];
        const hosts = collectEmbedHostsForWidget(w, ag, websiteRows);
        if (hosts.size === 0) return true;
        return hosts.has(LOOPBACK_EMBED_CANONICAL);
      });
      if (candidates.length === 1) {
        matches = candidates;
      }
    }

    // Local dev (non-production): exactly one widget row in the DB — allow bare loader on loopback without ?wid=
    if (
      matches.length === 0 &&
      allowLooseLoopback &&
      requestCanonical === LOOPBACK_EMBED_CANONICAL &&
      !narrowWid &&
      widgets.length === 1
    ) {
      matches = [widgets[0]];
    }

    if (matches.length === 0) {
      return res.status(404).json({
        status_code: 404,
        message:
          'No widget matched this page. Add your widget id: script src=".../widget-loader.js?wid=YOUR_ID" (copy from Chataffy → Widget setup). Or use the full script with wid, token, and agent.',
      });
    }

    if (matches.length > 1) {
      return res.status(409).json({
        status_code: 409,
        message:
          'Multiple widgets match; use the full embed URL with wid, token, and agent, or call /api/widget/embed?origin=...&wid=<your widget id>.',
      });
    }

    const w = matches[0];
    return res.status(200).json({
      status_code: 200,
      data: {
        wid: String(w._id),
        token: w.widgetToken,
        agent: String(w.agentId),
      },
    });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({
      status: false,
      message: 'Something went wrong please try again!',
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

// Update widget horizontal alignment (legacy body: { position: { align } } still accepted)
WidgetController.updateWidgetPosition = async (req, res) => {
  try {
    const { agentId, position, align: alignBody } = req.body;
    const alignRaw = alignBody ?? position?.align;

    if (!agentId) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "AgentId is required" 
      });
    }

    if (alignRaw === undefined && !position) {
      return res.status(400).json({ 
        status_code: 400, 
        message: "align or position.align is required" 
      });
    }

    const align = ['left', 'right'].includes(alignRaw) ? alignRaw : 'right';

    const updatedWidget = await Widget.findOneAndUpdate(
      { agentId },
      { $set: { align }, $unset: { position: 1 } },
      { new: true }
    );
    
    if (updatedWidget) {
      res.status(200).json({ 
        status_code: 200, 
        message: "Widget alignment updated successfully",
        data: { align: updatedWidget.align }
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

// POST /widget/toggle-status — toggle isActive (1/0) for a widget by agentId
WidgetController.toggleWidgetStatus = async (req, res) => {
  try {
    const { agentId, isActive } = req.body;
    if (!agentId) {
      return res.status(400).json({ status_code: 400, status: false, message: 'agentId is required' });
    }
    if (isActive === undefined) {
      return res.status(400).json({ status_code: 400, status: false, message: 'isActive is required' });
    }

    const widget = await Widget.findOneAndUpdate(
      { agentId },
      { $set: { isActive: isActive ? 1 : 0 } },
      { new: true }
    );

    if (!widget) {
      return res.status(404).json({ status_code: 404, status: false, message: 'Widget not found for this agent' });
    }

    return res.status(200).json({ status_code: 200, status: true, message: 'Widget status updated', isActive: widget.isActive });
  } catch (error) {
    commonHelper.logErrorToFile(error);
    return res.status(500).json({ status_code: 500, status: false, message: 'Failed to update widget status' });
  }
};

module.exports = WidgetController;