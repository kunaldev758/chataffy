const commonHelper = require("../helpers/commonHelper.js");
const TrainingList = require('../models/TrainingList');
const ObjectId  = require('mongoose').Types.ObjectId;

exports.getTrainingListDetail = async (req, res) => {
  try {
    const userId = req.body.userId;
    const {id} = req.body;
    const trainingList = await TrainingList.findById(id);
    if(!trainingList) {
      res.status(200).json({ status: false, message: "No matching record found" });    
      return;  
    }
    if(trainingList.userId != userId) {
      res.status(200).json({ status: false, message: "Not authorised for this training" });    
      return;  
    }
    switch(trainingList.type) {
      case 0:
        res.status(200).json({
          title: trainingList.title,
          type: trainingList.type,
          timeUsed: trainingList.timeUsed,
          lastEdit: trainingList.lastEdit,
          isActive: trainingList.isActive,
          webPage: {
            url: trainingList.webPage.url,
            title: trainingList.webPage.title,
            metaDescription: trainingList.webPage.metaDescription,
            content: trainingList.webPage.content,
            crawlingStatus: trainingList.webPage.crawlingStatus,
            sourceCode: trainingList.webPage.sourceCode
          },
          mapping: {
            mappingStatus: trainingList.mapping.mappingStatus
          }
        });
        break;
        
      case 1:
        res.status(200).json({
          title: trainingList.title,
          type: trainingList.type,
          timeUsed: trainingList.timeUsed,
          lastEdit: trainingList.lastEdit,
          isActive: trainingList.isActive,
          file: { 
            fileName: trainingList.file.fileName, 
            originalFileName: trainingList.file.originalFileName,
            path: trainingList.file.path,
            content: trainingList.file.content,
          },                  
          mapping: {
            mappingStatus: trainingList.mapping.mappingStatus
          }
        });
        break;
        
      case 2:
        res.status(200).json({
          title: trainingList.title,
          type: trainingList.type,
          timeUsed: trainingList.timeUsed,
          lastEdit: trainingList.lastEdit,
          isActive: trainingList.isActive,
          snippet: {
            title: trainingList.snippet.title,
            content: trainingList.snippet.content,
          },
          mapping: {
            mappingStatus: trainingList.mapping.mappingStatus
          }
        });
        break;
        
      case 3:
        res.status(200).json({
          title: trainingList.title,
          type: trainingList.type,
          timeUsed: trainingList.timeUsed,
          lastEdit: trainingList.lastEdit,
          isActive: trainingList.isActive,
          faq: {
            question: trainingList.faq.question,
            answer: trainingList.faq.answer,
          },
          mapping: {
            mappingStatus: trainingList.mapping.mappingStatus
          }
        });
        break;
      
      default:
        res.status(201).json({ status_code: 500, message: "Something went wrong please try again!" });
    }
      
  } catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};
