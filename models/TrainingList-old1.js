const mongoose = require("mongoose");
const trainingListSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  title: { type: String },
  type: { type: Number }, // 0-WebPage, 1-File, 2-Snippet, 3-Faq
  timeUsed: { type: Number, default: 0 },
  lastEdit: { type: Date, default: Date.now },
  trainingStatus: { type: Number, default: 1 }, // 1-Listed, 2-Crawled, 3-Minified, 4-Mapped
  isActive: { type: Number, default: 1}, // 0-InActive, 1-Active, 2-Delete

  mapping: {
    embedding: { type: Object }, 
    embeddingValues: { type: Array }, 
    mappingLocation: {
      'type': {
        type: String,
        enum: ["Point"]
      },
      coordinates: {
        type: [Number]
      } 
    },
    mappingStatus: { type: Number, default: 0 }, // 0-NotStarted, 1-Progress, 2-Success, 3-Failed

    mappingDuration: {
      start: Date,
      end: Date,
    },
  },

  webPage: {
    url: { type: String },
    title: { type: String },
    metaDescription: { type: String },
    content: { type: String },
    sitemapIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Sitemap" }],
    crawlingStatus: { type: Number, default: 0 }, // 0-NotStarted, 1-Progress, 2-Success, 3-Failed
    minifyingStatus: { type: Number, default: 0 }, // 0-NotStarted, 1-Progress, 2-Success, 3-Failed

    sourceCode: { type: String },

    crawlingDuration: {
      start: Date,
      end: Date,
    },
    minifyingDuration: {
      start: Date,
      end: Date,
    },
  },

  file: { 
    fileName: String, 
    originalFileName: String,
    path: String,
    content: String,
  },

  snippet: {
    title: { type: String },
    content: { type: String },
  },
  
  faq: {
    question: { type: String },
    answer: { type: String },
  }


},
{ timestamps: true });
trainingListSchema.index({ userId: 1, mappingLocation: "2dsphere" });
// trainingListSchema.index({ embedding: '2dsphere' });
const TrainingList = mongoose.model("TrainingList", trainingListSchema);
module.exports = TrainingList;
