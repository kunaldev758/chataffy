const mongoose = require("mongoose");
const snippetSchema = new mongoose.Schema({
  trainingListId: { type: mongoose.Schema.Types.ObjectId, ref: "TrainingList" },
  title: { type: String },
  content: { type: String },
  file: { 
    fileName: String, 
    originalFileName: String,
    path: String,
  },  
},
{ timestamps: true });
const Snippet = mongoose.model("Snippet", snippetSchema);
module.exports = Snippet;
