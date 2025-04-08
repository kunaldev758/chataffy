const commonHelper = require("../helpers/commonHelper.js");
const Widget = require('../models/Widget');
const ObjectId  = require('mongoose').Types.ObjectId;

const WidgetController = {};

WidgetController.getWidgetToken = async (req, res) => {
  try {
    const userId = req.body.userId;
    if(userId){
      const widget = await Widget.findOne({userId});
      res.status(200).json({ status_code: 200, data: {widgetId: widget._id, widgetToken: widget.widgetToken }});
    }else{
      res.status(201).json({ status_code: 201, message: "Something went wrong please try again!" });
    }
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};


WidgetController.setBasicInfo = async (req, res) => {
  try {
    const {userId, basicInfo} = req.body;
    if(userId){
      const updatedWidget = await Widget.findOneAndUpdate(
        { userId },
        { $set: { ...basicInfo }},
      );
      res.status(200).json({ status_code: 200, message: "Basic information saved."});
    }else{
      throw new Error(`No widget found with the given userId:${userId}`)
    }
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};


WidgetController.getBasicInfo = async (req, res) => {
  try {
    const {userId} = req.body;
    if(userId){
      const widget = await Widget.findOne({ userId });
      if(widget){
        res.status(200).json({ status_code: 200, data: {
          "website": widget.website,
          "organisation": widget.organisation,
          "fallbackMessage": widget.fallbackMessage,
          "email": widget.email,
          "phone": widget.phone,
        }});
      }      
      else{
        throw new Error(`No widget found with the given userId:${userId}`)
      }
    }else{
      throw new Error(`No user found with the given userId:${userId}`)
    }
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};


WidgetController.getThemeSettings = async (req, res) => {
  try {
    const userId = req.body.userId;
    const widgetId = req.body.widgetId;
    if(userId){
      const widget = await Widget.findOne({ userId:userId });
      if(widget){
        res.status(200).json({ status_code: 200, data: {
          "logo": widget.logo,
          "titleBar": widget.titleBar,
          "welcomeMessage": widget.welcomeMessage,
          "showLogo": widget.showLogo,
          "isPreChatFormEnabled": widget.isPreChatFormEnabled,
          "fields":widget.fields,
          "colorFields":widget.colorFields
        }});
      }      
      else{
        throw new Error(`No widget found with the given userId:${userId}`)
      }
    }else if(widgetId){
      const widget = await Widget.findOne({ _id:widgetId });
      if(widget){
        res.status(200).json({ status_code: 200, data: {
          "logo": widget.logo,
          "titleBar": widget.titleBar,
          "welcomeMessage": widget.welcomeMessage,
          "showLogo": widget.showLogo,
          "isPreChatFormEnabled": widget.isPreChatFormEnabled,
          "fields":widget.fields,
          "colorFields":widget.colorFields
        }});
      } 
      else{
        throw new Error(`No widget found with the given userId:${userId}`)
      }
    }else{
      throw new Error(`No user found with the given userId:${userId}`)
    }
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};

WidgetController.updateThemeSettings = async (req, res) => {
  try {
    const {userId} = req.body;
    const themeSettings = req.body?.themeSettings?.themeSettings
    if(userId){
      const widget = await Widget.findOne({ userId });
      if(widget){
        await Widget.updateOne({userId},{ 
          // logo:themeSettings.logo,
          titleBar : themeSettings.titleBar,
          welcomeMessage : themeSettings.welcomeMessage,
          showLogo : themeSettings.showLogo,
          isPreChatFormEnabled : themeSettings.isPreChatFormEnabled,
          fields : themeSettings.fields,
          colorFields : themeSettings.colorFields})
        res.status(200).json({ status_code: 200, data: {
          "logo": themeSettings.logo,
          "titleBar": themeSettings.titleBar,
          "welcomeMessage": themeSettings.welcomeMessage,
          "showLogo": themeSettings.showLogo,
          "isPreChatFormEnabled": themeSettings.isPreChatFormEnabled,
          "fields":themeSettings.fields,
          "colorFields":themeSettings.colorFields
        }});
      }      
      else{
        throw new Error(`No widget found with the given userId:${userId}`)
      }
    }else{
      throw new Error(`No user found with the given userId:${userId}`)
    }
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};

WidgetController.uploadLogo = async (req, res) => {
  try{
  const {userId} = req.body;
  if (!req.file) {
    return res.status(400).send({ error: 'No file uploaded' });
  }
  const filePath = `/uploads/${req.file.filename}`;
  await Widget.findOneAndUpdate({userId:userId},{logo:filePath},{ new: true });
  return res.status(200).send({ message: 'File uploaded successfully', filePath });
}catch(error){
  res.status(404).send({ error: 'something went wrong' });
}
};

module.exports = WidgetController;
