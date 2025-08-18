const mongoose = require("mongoose");
const trainingListSchema = new mongoose.Schema({
    userId: {
      type: String,
      required: true,
      index: true
    },
    type: {
      type: Number,
      required: true,
      // 0: WebPage, 1: File, 2: Snippet, 3: FAQ
    },
    
    // WebPage specific fields
    webPage: {
      url: String,
      sourceCode: String,
    },
  
    // File specific fields
    fileContent: String,
    fileName: String,
    originalFileName: String,
  
    // Snippet and FAQ fields
    title: String,
    content: String,
  
    // Common fields
    trainingStatus: {
      type: Number,
      default: 1,
      // 0:Processing 1: Trained, 2: Failed, 10: Plan Upgrade Required
    },
  
    error: {
      type: String,
      default: null
    },
    
    dataSize: {
      type: Number,
      default: 0 // Size in bytes
    },
    chunkCount: {
      type: Number,
      default: 0
    },
  
  
    lastEdit: {
      type: Date,
      default: Date.now,
    },
  
    createdAt: {
      type: Date,
      default: Date.now,
    },
 
  // { timestamps: true }
});

trainingListSchema.index({ userId: 1, trainingStatus: 1 });
trainingListSchema.index({ userId: 1, type: 1 });
trainingListSchema.index({ createdAt: 1 });

const TrainingList = mongoose.model("TrainingList", trainingListSchema);
module.exports = TrainingList;
