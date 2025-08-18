const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const officeParser = require("officeparser");

// Supported file types and their MIME types
const SUPPORTED_TYPES = {
  'text/plain': 'text',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};

async function readFileContent(filePath, mimeType) {
  return new Promise((resolve, reject) => {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    // Check if file type is supported
    if (!SUPPORTED_TYPES[mimeType]) {
      return reject(new Error(`Unsupported file type: ${mimeType}`));
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const maxSize = 50 * 1024 * 1024; // 50MB max file size
    
    if (stats.size > maxSize) {
      return reject(new Error(`File size too large: ${stats.size} bytes. Maximum allowed: ${maxSize} bytes`));
    }

    console.log(`Processing file: ${filePath}, MIME: ${mimeType}, Size: ${stats.size} bytes`);

    try {
      switch (mimeType) {
        case "text/plain":
          processTextFile(filePath, resolve, reject);
          break;
          
        case "application/pdf":
          processPdfFile(filePath, resolve, reject);
          break;
          
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          processDocxFile(filePath, resolve, reject);
          break;
          
        case "application/msword":
          processDocFile(filePath, resolve, reject);
          break;
          
        case "application/vnd.ms-excel":
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
          processExcelFile(filePath, resolve, reject);
          break;
          
        case "application/vnd.ms-powerpoint":
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
          processPowerPointFile(filePath, resolve, reject);
          break;
          
        default:
          reject(new Error(`Unsupported file type: ${mimeType}`));
      }
    } catch (error) {
      reject(new Error(`Error processing file: ${error.message}`));
    }
  });
}

function processTextFile(filePath, resolve, reject) {
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      reject(new Error(`Error reading text file: ${err.message}`));
    } else {
      resolve(cleanContent(data));
    }
  });
}

function processPdfFile(filePath, resolve, reject) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      reject(new Error(`Error reading PDF file: ${err.message}`));
    } else {
      pdfParse(data)
        .then((result) => {
          if (!result.text || result.text.trim().length === 0) {
            reject(new Error("PDF file appears to be empty or contains no extractable text"));
          } else {
            resolve(cleanContent(result.text));
          }
        })
        .catch((error) => {
          reject(new Error(`Error parsing PDF: ${error.message}`));
        });
    }
  });
}

function processDocxFile(filePath, resolve, reject) {
  mammoth
    .extractRawText({ path: filePath })
    .then((result) => {
      if (!result.value || result.value.trim().length === 0) {
        reject(new Error("DOCX file appears to be empty or contains no extractable text"));
      } else {
        resolve(cleanContent(result.value));
      }
    })
    .catch((error) => {
      reject(new Error(`Error parsing DOCX: ${error.message}`));
    });
}

function processDocFile(filePath, resolve, reject) {
  officeParser.parseOfficeAsync(filePath, (err, data) => {
    if (err) {
      reject(new Error(`Error parsing DOC: ${err.message}`));
    } else if (!data || data.trim().length === 0) {
      reject(new Error("DOC file appears to be empty or contains no extractable text"));
    } else {
      resolve(cleanContent(data));
    }
  });
}

function processExcelFile(filePath, resolve, reject) {
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    let allText = '';
    
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      
      sheetData.forEach(row => {
        if (Array.isArray(row)) {
          allText += row.join(' ') + '\n';
        }
      });
    });
    
    if (!allText || allText.trim().length === 0) {
      reject(new Error("Excel file appears to be empty or contains no extractable text"));
    } else {
      resolve(cleanContent(allText));
    }
  } catch (error) {
    reject(new Error(`Error parsing Excel file: ${error.message}`));
  }
}

function processPowerPointFile(filePath, resolve, reject) {
  officeParser.parseOfficeAsync(filePath, (err, data) => {
    if (err) {
      reject(new Error(`Error parsing PowerPoint: ${err.message}`));
    } else if (!data || data.trim().length === 0) {
      reject(new Error("PowerPoint file appears to be empty or contains no extractable text"));
    } else {
      resolve(cleanContent(data));
    }
  });
}

function cleanContent(content) {
  if (!content) return '';
  
  return content
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n')   // Handle Mac line endings
    .replace(/\n{3,}/g, '\n\n') // Reduce excessive line breaks
    .replace(/\t/g, ' ')    // Replace tabs with spaces
    .replace(/ {2,}/g, ' ') // Replace multiple spaces with single space
    .trim();
}

function getFileInfo(filePath, mimeType) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  
  return {
    size: stats.size,
    extension,
    mimeType,
    isSupported: !!SUPPORTED_TYPES[mimeType],
    type: SUPPORTED_TYPES[mimeType] || 'unknown'
  };
}

module.exports = {
  readFileContent,
  getFileInfo,
  SUPPORTED_TYPES
};