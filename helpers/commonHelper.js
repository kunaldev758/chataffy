const fs = require("fs");
const jwt = require('jsonwebtoken');
const TrainingList = require('../models/TrainingList');


async function getWebPageCount(userId) {
  try {
    const usersId = clientId;
    const  userData = await TrainingList.find({usersId, type:0});
    return { total: userData.credits.total, used: userData.credits.used };
  } catch (error) {
    commonHelper.logErrorToFile(error);
    //res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
}

// Function to store error logs in a file
function logErrorToFile(error) {
  const logFilePath = "error.log";
  const logMessage = `${new Date().toISOString()} - ${error.stack}\n`;

  fs.appendFile(logFilePath, logMessage, (err) => {
    if (err) {
      console.error("Error writing to log file:", err);
    }
  });
}

module.exports = { logErrorToFile, getWebPageCount};
