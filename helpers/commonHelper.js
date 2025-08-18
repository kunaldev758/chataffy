const fs = require("fs");
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

module.exports = { logErrorToFile};
