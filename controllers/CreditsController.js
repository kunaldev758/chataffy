const commonHelper = require("../helpers/commonHelper.js");
const Client = require('../models/Client');
// const ObjectId  = require('mongoose').Types.ObjectId;
exports.getUserCredits = async function getUserCredits(userId) {
  try {
    const clientData = await Client.findOne({userId});
    return { total: clientData.credits.total, used: clientData.credits.used };
    // if(userData){
    //   res.send({ total: userData.credits.total, used: userData.credits.used });
    // }else{
    //   res.send({ status: false, message: "User not found!" });
    // }
    
  } catch (error) {
    commonHelper.logErrorToFile(error);
    //res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};
