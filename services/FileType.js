async function readFileContent(filePath, mimeType) {
    return new Promise((resolve, reject) => {
      if (mimeType === "text/plain") {
        fs.readFile(filePath, "utf8", (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      } else if (mimeType === "application/pdf") {
        fs.readFile(filePath, (err, data) => {
          if (err) reject(err);
          pdfParse(data)
            .then((data) => resolve(data.text))
            .catch(reject);
        });
      } else if (
        mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        mammoth
          .extractRawText({ path: filePath })
          .then((result) => resolve(result.value))
          .catch(reject);
      } else if (mimeType === "application/msword") {
        officeParser.parseOfficeAsync(filePath, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      } else {
        resolve("");
      }
    });
  }

  module.exports = {
    readFileContent,
  };