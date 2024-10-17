const mongoose = require('mongoose');

let visitorSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' }, // client 
    name: {type:String, required: true},
    lastMessage: {type: String},
  },
  { timestamps: true }
);

const Visitor = mongoose.model('Visitor', visitorSchema);
module.exports = Visitor;