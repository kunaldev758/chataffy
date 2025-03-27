const commonHelper = require("../helpers/commonHelper.js");
const Client = require('../models/Client');
exports.getUserCredits = async function getUserCredits(userId) {
  try {
    const clientData = await Client.findOne({userId});
    return { total: clientData.credits.total, used: clientData.credits.used };
    
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};
