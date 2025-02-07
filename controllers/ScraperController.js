// const axios = require("axios");
// const cheerio = require("cheerio");
// const path = require('path');
// const fs = require('fs');
// const pdfParse = require('pdf-parse');
// const mammoth = require('mammoth');
// const TrainingList = require("../models/TrainingList");
// const Client = require("../models/Client");
// const urlModule = require('url');
// const OpenAIController = require("./OpenAIController");
// const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
// const { Pinecone } = require("@pinecone-database/pinecone");
// const { MarkdownTextSplitter } = require("langchain/text_splitter");

// const ScraperController = {};
// const processingStatus = {};

// // Pricing Calculator
// class TrainingPricingCalculator {
//     constructor() {
//       this.rates = {
//         embedding: { ada: 0.0001 }, // per 1K tokens
//         pinecone: { storage: 0.0002 } // per vector per month
//       };
//     }
  
//     async estimateTokens(text) {
//       return Math.ceil(text.length / 4);
//     }
  
//     calculateEmbeddingCost(tokens) {
//       return (tokens / 1000) * this.rates.embedding.ada;
//     }
  
//     calculatePineconeStorageCost(vectorCount, months = 1) {
//       return vectorCount * this.rates.pinecone.storage * months;
//     }
//   }

// // File reading helper function
// const readFileContent = async (filePath, mimeType) => {
//   try {
//     switch (mimeType) {
//       case 'text/plain':
//         return await fs.promises.readFile(filePath, 'utf8');
      
//       case 'application/pdf':
//         const pdfBuffer = await fs.promises.readFile(filePath);
//         const pdfData = await pdfParse(pdfBuffer);
//         return pdfData.text;
      
//       case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
//         const docxResult = await mammoth.extractRawText({ path: filePath });
//         return docxResult.value;
      
//       default:
//         return '';
//     }
//   } catch (error) {
//     console.error('Error reading file:', error);
//     throw error;
//   }
// };

// // Main sitemap scraping functionality
// ScraperController.scrape = async (req, res) => {
//   const { sitemap } = req.body;
//   const userId = req.body.userId;

//   try {
//     if (processingStatus[userId]?.isProcessing) {
//       return res.status(200).json({ 
//         status: false, 
//         message: "Already processing a sitemap" 
//       });
//     }

//     processingStatus[userId] = { isProcessing: true };
//     res.status(200).json({ 
//       status: true, 
//       message: "Sitemap processing started" 
//     });

//     const urls = await extractUrlsFromSitemap(sitemap);
//     await createTrainingRecords(urls, userId);
//     req.io.to('user'+userId).emit('urls-added', {
//       count: urls.length,
//       message: `${urls.length} URLs found and added for processing`
//     });

//     await processUrls(urls, userId, req);

//     processingStatus[userId].isProcessing = false;
//     req.io.to('user'+userId).emit('processing-complete', {
//       message: 'All URLs have been processed'
//     });

//   } catch (error) {
//     console.error('Sitemap processing error:', error);
//     processingStatus[userId].isProcessing = false;
//     req.io.to('user'+userId).emit('processing-error', {
//       message: 'Error processing sitemap'
//     });
//   }
// };

// // FAQ Creation
// ScraperController.createFaq = async (req, res) => {
//   const { question, answer } = req.body;
//   const userId = req.body.userId;

//   try {
//     // Create FAQ record
//     const trainingList = new TrainingList({
//       userId,
//       title: question,
//       type: 1, // FAQ type
//       faq: { question, answer },
//       trainingStatus: 1
//     });
//     await trainingList.save();

//     // Create embedding for the FAQ
//     try {
//       const embeddingData = await OpenAIController.createEmbedding([question]);
//       const mappings = [{
//         content: `Question: ${question}\nAnswer: ${answer}`,
//         embeddingValues: embeddingData[0].embedding
//       }];

//       await TrainingList.findByIdAndUpdate(trainingList._id, {
//         mappings,
//         trainingStatus: 4 // Completed status
//       });

//       // Update client status
//       await Client.updateOne(
//         { userId: userId },
//         { faqAdded: true }
//       );

//       res.status(200).json({
//         status: true,
//         message: "FAQ added successfully"
//       });

//     } catch (error) {
//       console.error("FAQ embedding error:", error);
//       await TrainingList.findByIdAndUpdate(trainingList._id, {
//         trainingStatus: 9 // Error status
//       });
//       res.status(500).json({
//         status: false,
//         message: "Error processing FAQ"
//       });
//     }
//   } catch (error) {
//     console.error("FAQ creation error:", error);
//     res.status(500).json({
//       status: false,
//       message: "Error creating FAQ"
//     });
//   }
// };

// // Document/Snippet Creation
// ScraperController.createSnippet = async (req, res) => {
//   const userId = req.body.userId;
//   const { title, content } = req.body;
//   const file = req.file;

//   try {
//     // Handle text snippet if provided
//     if (title && content) {
//       const snippetList = new TrainingList({
//         userId,
//         title,
//         type: 2, // Snippet type
//         snippet: { title, content },
//         trainingStatus: 1
//       });
//       await snippetList.save();
//       await processSnippet(snippetList, content);
//     }

//     // Handle file if provided
//     if (file) {
//       const filePath = path.join(__dirname, '..', file.path);
//       const fileContent = await readFileContent(filePath, file.mimetype);
      
//       const fileList = new TrainingList({
//         userId,
//         title: file.originalname,
//         type: 3, // File type
//         file: {
//           fileName: file.filename,
//           originalFileName: file.originalname,
//           path: file.path,
//           content: fileContent
//         },
//         trainingStatus: 1
//       });
//       await fileList.save();
//       await processSnippet(fileList, fileContent);
//     }

//     // Update client status
//     await Client.updateOne(
//       { userId: userId },
//       { docSnippetAdded: true }
//     );

//     res.status(200).json({
//       status: true,
//       message: "Content added successfully"
//     });

//   } catch (error) {
//     console.error("Snippet creation error:", error);
//     res.status(500).json({
//       status: false,
//       message: "Error processing content"
//     });
//   }
// };

// // Helper function to process snippets
// async function processSnippet(trainingList, content) {
//   try {
//     const chunks = splitContent(content, 1200);
//     const input = chunks.map(chunk => chunk.content);
//     const embeddingData = await OpenAIController.createEmbedding(input);
    
//     const mappings = chunks.map((chunk, index) => ({
//       content: chunk.content,
//       embeddingValues: embeddingData[index].embedding
//     }));

//     await TrainingList.findByIdAndUpdate(trainingList._id, {
//       mappings,
//       trainingStatus: 4 // Completed status
//     });
//   } catch (error) {
//     console.error("Error processing snippet:", error);
//     await TrainingList.findByIdAndUpdate(trainingList._id, {
//       trainingStatus: 9 // Error status
//     });
//     throw error;
//   }
// }

// // Stats and Status Methods
// ScraperController.getStats = async (req, res) => {
//   const userId = req.body.userId;
//   try {
//     const stats = await TrainingList.aggregate([
//       {
//         $match: { userId }
//       },
//       {
//         $group: {
//           _id: '$type',
//           total: { $sum: 1 },
//           completed: {
//             $sum: {
//               $cond: [{ $eq: ['$trainingStatus', 4] }, 1, 0]
//             }
//           },
//           failed: {
//             $sum: {
//               $cond: [{ $eq: ['$trainingStatus', 9] }, 1, 0]
//             }
//           }
//         }
//       }
//     ]);

//     res.status(200).json({
//       status: true,
//       data: stats
//     });
//   } catch (error) {
//     res.status(500).json({
//       status: false,
//       message: "Error fetching stats"
//     });
//   }
// };

// // Helper functions (unchanged from previous version)
// async function extractUrlsFromSitemap(sitemapUrl) {
//   // ... (same as before)
//   try {
//     const response = await axios.get(sitemapUrl);
//     const $ = cheerio.load(response.data, { xmlMode: true });
    
//     return $("loc:not(sitemap loc)")
//       .map((_, element) => $(element).text().trim())
//       .get();
//   } catch (error) {
//     console.error('Error extracting URLs:', error);
//     throw error;
//   }
// }

// function splitContent(content, maxLength) {
//   // ... (same as before)
//   const chunks = [];
//   let start = 0;
  
//   while (start < content.length) {
//     chunks.push({
//       content: content.substr(start, maxLength)
//     });
//     start += maxLength;
//   }
  
//   return chunks;
// }

// async function processUrls(urls, userId, req) {
//   // ... (same as before)
// }

// async function createTrainingRecords(urls, userId) {
//   // ... (same as before)
// }

// module.exports = ScraperController;


//---------------------------------------------------------------------------------------------------------------


const axios = require("axios");
const cheerio = require("cheerio");
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Client = require("../models/Client");
const Sitemap = require("../models/Sitemap");
const TrainingList = require("../models/TrainingList");
const OpenAIController = require("./OpenAIController");
const urlModule = require('url');
const ObjectId = require("mongoose").Types.ObjectId;

const ScraperController = {};
const clientStatus = {};

// File reading helper for different file types
const readFileContent = async (filePath, mimeType) => {
  try {
    switch (mimeType) {
      case 'text/plain':
        return await fs.promises.readFile(filePath, 'utf8');
      
      case 'application/pdf':
        const pdfBuffer = await fs.promises.readFile(filePath);
        const pdfData = await pdfParse(pdfBuffer);
        return pdfData.text;
      
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const docxResult = await mammoth.extractRawText({ path: filePath });
        return docxResult.value;
      
      default:
        return '';
    }
  } catch (error) {
    console.error('Error reading file:', error);
    throw error;
  }
};

// Main sitemap scraping endpoint
ScraperController.scrape = async (req, res) => {
  const { sitemap } = req.body;
  const userId = req.body.userId;

  try {
    const client = await Client.findOne({ userId });
    
    if (client.sitemapScrappingStatus === 0 && client.webPageScrappingStatus === 0) {
      const existingSitemap = await Sitemap.findOne({ userId, url: sitemap });
      
      if (existingSitemap) {
        return res.status(200).json({ status: true, message: "Sitemap already added." });
      }

      let sitemapObj = await Sitemap.create({ userId, url: sitemap });
      res.status(200).json({ status: true, message: "Scraping process initiated." });
      
      client.sitemapScrappingStatus = 1;
      await client.save();

      // Process sitemap and nested sitemaps
      while (sitemapObj) {
        try {
          const response = await axios.get(sitemapObj.url);
          const $ = cheerio.load(response.data, { xmlMode: true });

          // Extract webpage URLs
          const webPageUrls = $("loc:not(sitemap loc)")
            .map((_, element) => $(element).text().trim())
            .get();

          if (webPageUrls.length) {
            await createTrainingListAndWebPages(webPageUrls, userId, sitemapObj._id);
            req.io.to('user' + userId).emit('web-pages-added');
            webPageCrawling(client, userId, req);
          }

          // Extract nested sitemaps
          const sitemapUrls = $("sitemap loc")
            .map((_, element) => $(element).text().trim())
            .get();

          if (sitemapUrls.length) {
            await insertOrUpdateSitemapRecords(sitemapUrls, userId, sitemapObj._id);
          }
        } catch (error) {
          console.error("Error processing sitemap:", sitemapObj.url, error);
        }

        sitemapObj.status = 1;
        await sitemapObj.save();
        sitemapObj = await Sitemap.findOne({ userId, status: 0 });
      }

      client.sitemapScrappingStatus = 0;
      await client.save();
    } else {
      const message = client.sitemapScrappingStatus === 1 
        ? "Sitemap scraping in progress" 
        : "Web-page scraping in progress";
      res.status(200).json({ status: false, message });
    }
  } catch (error) {
    console.error("Scraping error:", error);
    req.io.emit("scraping-failed", { message: "Scraping process failed." });
  }
};

// FAQ creation endpoint
ScraperController.createFaq = async (req, res) => {
  const { question, answer } = req.body;
  const userId = req.body.userId;

  try {
    const trainingList = new TrainingList({
      userId,
      title: question,
      type: 1,
      faq: { question, answer },
      trainingStatus: 1
    });
    await trainingList.save();

    try {
      const embeddingData = await OpenAIController.createEmbedding([question]);
      const mappings = [{
        content: `Question: ${question}\nAnswer: ${answer}`,
        embeddingValues: embeddingData[0].embedding
      }];

      await TrainingList.findByIdAndUpdate(trainingList._id, {
        mappings,
        lastEdit: Date.now(),
        trainingStatus: 4
      });

      await Client.updateOne({ userId }, { faqAdded: true });
      res.status(200).json({ status: true, message: "FAQ added successfully" });
    } catch (error) {
      console.error("FAQ embedding error:", error);
      await TrainingList.findByIdAndUpdate(trainingList._id, {
        lastEdit: Date.now(),
        trainingStatus: 9
      });
      res.status(500).json({ status: false, message: "Error processing FAQ" });
    }
  } catch (error) {
    console.error("FAQ creation error:", error);
    res.status(500).json({ status: false, message: "Error creating FAQ" });
  }
};

// Snippet/Document creation endpoint
ScraperController.createSnippet = async (req, res) => {
  try {
    const { title, content } = req.body;
    const file = req.file;
    const userId = req.body.userId;

    if (title && content) {
      const trainingList = new TrainingList({
        userId,
        title,
        type: 2,
        snippet: { title, content }
      });
      await trainingList.save();
      await processContentMapping(trainingList, content);
    }

    if (file) {
      const filePath = path.join(__dirname, '..', file.path);
      const fileContent = await readFileContent(filePath, file.mimetype);
      
      const trainingList = new TrainingList({
        userId,
        title: file.originalname,
        type: 3,
        file: {
          fileName: file.filename,
          originalFileName: file.originalname,
          path: file.path,
          content: fileContent
        }
      });
      await trainingList.save();
      await processContentMapping(trainingList, fileContent);
    }

    await Client.updateOne({ userId }, { docSnippetAdded: true });
    res.status(200).json({ status: true, message: "Content added successfully" });
  } catch (error) {
    console.error("Snippet creation error:", error);
    res.status(500).json({ status: false, message: "Error processing content" });
  }
};

// Helper function to process content mapping
async function processContentMapping(trainingList, content) {
  try {
    const chunks = splitContent(content, 1200);
    const input = chunks.map(chunk => chunk.content);
    const embeddingData = await OpenAIController.createEmbedding(input);
    
    const mappings = chunks.map((chunk, index) => ({
      content: chunk.content,
      embeddingValues: embeddingData[index].embedding
    }));

    await TrainingList.findByIdAndUpdate(trainingList._id, {
      mappings,
      lastEdit: Date.now(),
      trainingStatus: 4
    });
  } catch (error) {
    console.error("Content mapping error:", error);
    await TrainingList.findByIdAndUpdate(trainingList._id, {
      lastEdit: Date.now(),
      trainingStatus: 9
    });
    throw error;
  }
}

// Web page processing functions
async function webPageCrawling(client, userId, req) {
  try {
    if (clientStatus[userId]?.webPageCrawling) return;
    clientStatus[userId] = { webPageCrawling: true };

    let trainingListObjArray;
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        trainingStatus: 1
      }).limit(10);

      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
        await TrainingList.findByIdAndUpdate(trainingListObj._id, {
          'trainingProcessStatus.crawlingStatus': 1,
          'trainingProcessStatus.crawlingDuration.start': Date.now()
        });

        try {
          const response = await axios.get(trainingListObj.webPage.url);
          
          await TrainingList.findByIdAndUpdate(trainingListObj._id, {
            'webPage.sourceCode': response.data,
            'trainingProcessStatus.crawlingStatus': 2,
            'trainingProcessStatus.crawlingDuration.end': Date.now(),
            'trainingStatus': 2
          });
          trainingListObj.trainingStatus = 2;
        } catch (error) {
          console.error("Crawling error:", error);
          await TrainingList.findByIdAndUpdate(trainingListObj._id, {
            'trainingProcessStatus.crawlingStatus': 3,
            'lastEdit': Date.now(),
            'trainingStatus': 9
          });
          trainingListObj.trainingStatus = 9;
        }
      }));

      if (trainingListObjArray.length) {
        const updatedCrawledCount = await TrainingList.countDocuments({
          userId: new ObjectId(userId),
          type: 0,
          'trainingProcessStatus.crawlingStatus': 2
        });
        
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user' + userId).emit('web-pages-crawled', {
          updatedCrawledCount,
          list
        });

        webPageMinifying(client, userId, req);
      }
    } while (trainingListObjArray.length > 0);

    clientStatus[userId].webPageCrawling = false;
  } catch (error) {
    console.error("Web page crawling error:", error);
    clientStatus[userId].webPageCrawling = false;
  }
}

// Helper functions
function splitContent(content, maxLength) {
  const chunks = [];
  let start = 0;
  
  while (start < content.length) {
    chunks.push({
      content: content.substr(start, maxLength)
    });
    start += maxLength;
  }
  
  return chunks;
}

async function insertOrUpdateSitemapRecords(urls, userId, sitemapId) {
  const existingRecords = await Sitemap.find({ url: { $in: urls }, userId });

  for (const url of urls) {
    const existingRecord = existingRecords.find(record => record.url === url);

    if (existingRecord) {
      if (!existingRecord.parentSitemapIds.includes(sitemapId)) {
        existingRecord.parentSitemapIds.push(sitemapId);
        await existingRecord.save();
      }
    } else {
      await Sitemap.create({
        userId,
        url,
        parentSitemapIds: [sitemapId]
      });
    }
  }
}

async function createTrainingListAndWebPages(urls, userId, sitemapId) {
  const trainingListDocuments = urls.map(url => ({
    userId,
    title: url,
    type: 0,
    webPage: {
      url,
      sitemapIds: [sitemapId]
    }
  }));

  await TrainingList.insertMany(trainingListDocuments);
}

// Stats endpoints
ScraperController.getWebPageUrlCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: { userId: new ObjectId(userId), type: 0 }
      },
      {
        $group: {
          _id: null,
          totalUrlCount: { $sum: 1 },
          crawledPagesCount: { 
            $sum: { 
              $cond: [
                { $eq: ['$trainingProcessStatus.crawlingStatus', 2] },
                1,
                0
              ]
            }
          },
          mappedPagesCount: {
            $sum: {
              $cond: [
                { $eq: ['$trainingProcessStatus.mappingStatus', 2] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const counts = result[0] || { totalUrlCount: 0, crawledPagesCount: 0, mappedPagesCount: 0 };
    return {
      totalPages: counts.totalUrlCount,
      crawledPages: counts.crawledPagesCount,
      mappedPages: counts.mappedPagesCount
    };
  } catch (error) {
    console.error("Error getting web page count:", error);
    throw error;
  }
};

ScraperController.getSnippetCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: { 
          userId: new ObjectId(userId),
          type: { $in: [2, 3] }
        }
      },
      {
        $group: {
          _id: null,
          totalDocs: { $sum: 1 },
          crawledDocs: { 
            $sum: { 
              $cond: [
                { $eq: ['$trainingStatus', 4] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const counts = result[0] || { crawledDocs: 0, totalDocs: 0 };
    return counts;
  } catch (error) {
    console.error("Error getting snippet count:", error);
    throw error;
  }
};

ScraperController.getFaqCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: { userId: new ObjectId(userId), type: 1 }
      },
      {
        $group: {
          _id: null,
          totalFaqs: { $sum: 1 },
          crawledFaqs: {
            $sum: {
              $cond: [
                { $eq: ['$trainingStatus', 4] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const counts = result[0] || { crawledFaqs: 0, totalFaqs: 0 };
    return counts;
  } catch (error) {
    console.error("Error getting FAQ count:", error);
    throw error;
  }
};

module.exports = ScraperController;