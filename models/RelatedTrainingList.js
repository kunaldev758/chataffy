const mongoose = require("mongoose");
const relatedTrainingListSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  chatMessageId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'ChatMessage' },
  message: String,
  mapping: {
    embedding: { type: Object }, 
    mappingLocation: {
      'type': {
        type: String,
        enum: ["Point"]
      },
      coordinates: {
        type: [Number]
      } 
    },
    mappingDuration: {
      start: Date,
      end: Date,
    },
  },
  trainingListIds: [
    { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'TrainingList' }
  ]
},
{ timestamps: true });
relatedTrainingListSchema.index({ userId: 1, chatMessageId: 1 });
// trainingListSchema.index({ embedding: '2dsphere' });
const relatedTrainingList = mongoose.model("RelatedTrainingList", relatedTrainingListSchema);
module.exports = relatedTrainingList;
