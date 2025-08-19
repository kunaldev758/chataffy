// controllers/ScrapingController.js
const PlanService = require("../services/PlanService");
const Client = require("../models/Client.js");
const Url = require("../models/Url.js");
const ContentValidationService = require("../services/ContentValidationService.js");
const batchTrainingService = require("../services/BatchTrainingService.js");
const { readFileContent } = require("../utils/fileReader.js");
const appEvents = require("../events.js");
const axios = require("axios");
const xml2js = require("xml2js");
const { urlProcessingQueue } = require("../services/jobService.js");

class ScrapingController {
  constructor() {
    this.startSitemapScraping = this.startSitemapScraping.bind(this);
    this.ContinueScrappingAfterUpgrade =
      this.ContinueScrappingAfterUpgrade.bind(this);
    this.upgradePlan = this.upgradePlan.bind(this);
    this.getScrapingHistory = this.getScrapingHistory.bind(this);
  }


  // Method 1: Simple Bulk Insert (Recommended for most cases)
async bulkInsertUrls(userId, urls) {
  try {
    console.log(`🚀 Bulk inserting ${urls.length} URLs...`);
    const startTime = Date.now();

    const urlDocuments = urls.map(url => ({
      userId: userId,
      url: url,
      trainStatus: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    // MongoDB bulk insert
    const result = await Url.insertMany(urlDocuments, {
      ordered: false, // Continue on duplicates/errors
      rawResult: true // Get detailed results
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Inserted ${result.insertedCount} URLs in ${duration}s`);
    return result;

  } catch (error) {
    // Handle duplicate key errors gracefully
    if (error.code === 11000) {
      console.log(`⚠️ Some URLs already exist. Inserted: ${error.result?.nInserted || 0}`);
      return error.result;
    }
    throw error;
  }
}

// Method 2: Chunked Insert (For very large datasets > 10k URLs)
// async chunkedBulkInsert(userId, urls, chunkSize = 1000) {
//   try {
//     console.log(`🔄 Chunked insert: ${urls.length} URLs in ${chunkSize} chunks`);
//     const startTime = Date.now();
    
//     let totalInserted = 0;
//     const totalChunks = Math.ceil(urls.length / chunkSize);

//     for (let i = 0; i < urls.length; i += chunkSize) {
//       const chunk = urls.slice(i, i + chunkSize);
//       const chunkNumber = Math.floor(i / chunkSize) + 1;
      
//       console.log(`📦 Chunk ${chunkNumber}/${totalChunks} (${chunk.length} URLs)`);
      
//       const urlDocuments = chunk.map(url => ({
//         userId: userId,
//         url: url,
//         trainStatus: 0,
//         createdAt: new Date(),
//         updatedAt: new Date()
//       }));

//       try {
//         const result = await Url.insertMany(urlDocuments, { 
//           ordered: false,
//           rawResult: true 
//         });
//         totalInserted += result.insertedCount;
        
//       } catch (chunkError) {
//         if (chunkError.code === 11000) {
//           totalInserted += chunkError.result?.nInserted || 0;
//         }
//         console.log(`⚠️ Chunk ${chunkNumber} partial success`);
//       }
//     }

//     const duration = ((Date.now() - startTime) / 1000).toFixed(2);
//     console.log(`🎯 Completed: ${totalInserted}/${urls.length} in ${duration}s`);
//     return totalInserted;

//   } catch (error) {
//     console.error('❌ Chunked insert failed:', error.message);
//     throw error;
//   }
// }

// // Method 3: Upsert Approach (Update existing, insert new)
// async upsertUrls(userId, urls) {
//   try {
//     console.log(`🔄 Upserting ${urls.length} URLs...`);
//     const startTime = Date.now();

//     const operations = urls.map(url => ({
//       updateOne: {
//         filter: { userId: userId, url: url },
//         update: { 
//           $set: { updatedAt: new Date() },
//           $setOnInsert: { 
//             userId: userId, 
//             url: url, 
//             trainStatus: 0, 
//             createdAt: new Date() 
//           }
//         },
//         upsert: true
//       }
//     }));

//     const result = await Url.bulkWrite(operations, { ordered: false });
    
//     const duration = ((Date.now() - startTime) / 1000).toFixed(2);
//     console.log(`✅ Upserted: ${result.upsertedCount} new, ${result.modifiedCount} updated in ${duration}s`);
//     return result;

//   } catch (error) {
//     console.error('❌ Upsert failed:', error.message);
//     throw error;
//   }
// }

  async extractUrlsFromSitemap(sitemapUrl) {
    try {
      console.log(`Fetching sitemap: ${sitemapUrl}`);
      
      const response = await axios.get(sitemapUrl, {
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
        },
        // Add validateStatus to handle 404s gracefully
        validateStatus: function (status) {
          return status < 500; // Accept any status code less than 500
        }
      });
  
      // Handle non-200 status codes
      if (response.status === 404) {
        console.warn(`Sitemap not found (404): ${sitemapUrl}`);
        return []; // Return empty array instead of throwing error
      }
      
      if (response.status !== 200) {
        console.warn(`Unexpected status ${response.status} for sitemap: ${sitemapUrl}`);
        return [];
      }
  
      // Check if response has valid XML content
      if (!response.data || typeof response.data !== 'string') {
        console.warn(`Invalid XML content from sitemap: ${sitemapUrl}`);
        return [];
      }
  
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(response.data);
      let urls = [];
  
      // Handle regular sitemap
      if (result.urlset && result.urlset.url) {
        urls = result.urlset.url.map((urlObj) => urlObj.loc[0]);
        console.log(`Found ${urls.length} URLs in regular sitemap: ${sitemapUrl}`);
        if (urls.length >= 1000) {
          urls = urls.slice(0, 1000); // Take only first 5000 URLs
          console.log(`URL limit reached. Returning first 5000 URLs from sitemap: ${sitemapUrl}`);
          return urls;
        }
      }
      // Handle sitemap index
      else if (result.sitemapindex && result.sitemapindex.sitemap) {
        const sitemapUrls = result.sitemapindex.sitemap.map(
          (sitemapObj) => sitemapObj.loc[0]
        );
        
        console.log(`Found ${sitemapUrls.length} nested sitemaps in index: ${sitemapUrl}`);
  
        // Recursively fetch URLs from each sitemap with better error handling
        for (const nestedSitemapUrl of sitemapUrls) {
          if (urls.length >= 1000) {
            console.log(`URL limit of 5000 reached. Stopping sitemap processing.`);
            break;
          }
          try {
            const nestedUrls = await this.extractUrlsFromSitemap(nestedSitemapUrl);
            urls.push(...nestedUrls);
            console.log(`Successfully extracted ${nestedUrls.length} URLs from nested sitemap: ${nestedSitemapUrl}`);
            if (urls.length >= 1000) {
              urls = urls.slice(0, 1000); // Trim to exactly 5000 URLs
              console.log(`URL limit of 5000 reached after processing nested sitemap. Stopping and returning 5000 URLs.`);
              return urls;
            }
          } catch (error) {
            console.warn(`Failed to fetch nested sitemap ${nestedSitemapUrl}:`, error.message);
            // Continue with other sitemaps instead of failing completely
            continue;
          }
        }
      } else {
        console.warn(`No valid sitemap structure found in: ${sitemapUrl}`);
        return [];
      }
  
      // Filter and clean URLs
      const originalCount = urls.length;
      urls = urls
        .filter((url) => url && typeof url === "string")
        .filter((url) => url.startsWith("http"))
        .map((url) => url.trim())
        .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates
  
      console.log(`Cleaned URLs: ${originalCount} -> ${urls.length} (removed ${originalCount - urls.length} invalid/duplicate URLs)`);

      if (urls.length > 1000) {
        urls = urls.slice(0, 1000);
        console.log(`Final URL count exceeded 5000 after cleaning. Trimmed to exactly 5000 URLs.`);
      }
      
      return urls;
  
    } catch (error) {
      // Log the error but don't throw - return empty array to continue processing
      console.error(`Error extracting URLs from sitemap ${sitemapUrl}:`, error.message);
      
      // Only throw if it's a critical error that should stop everything
      // For most cases, return empty array to continue processing other sitemaps
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.warn(`Network error for sitemap ${sitemapUrl}, continuing with other sitemaps...`);
        return [];
      }
      
      // For parsing errors or other non-critical errors, return empty array
      return [];
    }
  }

  // Start sitemap scraping
  async startSitemapScraping(req, res) {
    try {
      const { userId, sitemapUrl, url } = req.body;
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId",
        });
      }

      if (!sitemapUrl && !url) {
        return res.status(400).json({
          success: false,
          error: "At least one of sitemapUrl or url must be provided",
        });
      }

      const TrainingModel = await PlanService.getTrainingModel(userId);
      const plan = await PlanService.getUserPlan(userId);

      const client = await Client.findOne({ userId });
      if (!client) {
        return res.status(404).json({
          success: false,
          error: "Client not found",
        });
      }
      if (client.sitemapAdded == true && sitemapUrl) {
        return res.status(400).json({
          success: false,
          error: "one sitemap already added",
        });
      }
      const qdrantIndexName =
        client?.plan == "free"
          ? client?.qdrantIndexName
          : client?.qdrantIndexNamePaid;

      // Check if user is already scraping
      const scrapingStatus = await Client.findOne({ userId });
      if (scrapingStatus.dataTrainingStatus == 1) {
        return res.status(409).json({
          success: false,
          error: "Scraping already in progress for this user",
        });
      }
      //here updte the mongodb that scrapping started
      if (sitemapUrl) {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 1 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
        });
      }
      // Fetch and parse sitemap
      let urls = [];
      if (sitemapUrl) {
        urls = await this.extractUrlsFromSitemap(sitemapUrl);
        console.log(`Found ${urls.length} URLs in sitemap`);
      }
      if (url) {
        const batchService = new batchTrainingService();
        const urlArray = url.split(",").map((u) => u.trim());

        for (const singleUrl of urlArray) {
          // Check if the url already exists in the TrainingModel
          const existing = await TrainingModel.findOne({
            userId: userId,
            type: 0, // WebPage
            trainingStatus: 1,
            "webPage.url": singleUrl,
          });

          if (existing) {
            try {
              await batchService.deleteItemFromVectorStore(
                userId,
                singleUrl,
                0
              );
            } catch (error) {
              console.log(error);
            }
            await Url.deleteOne({ userId: userId, url: singleUrl });
            await TrainingModel.deleteOne({ _id: existing._id });
          }
        }
        urls.push(...urlArray);
      }

      if (urls.length == 0) {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          message: "No urls found",
          client: await Client.findOne({ userId }),
        });
      }

      // Add the fetched URLs to the Url model
      // for (const url of urls) {
        // await Url.create({ userId: userId, url: url, trainStatus: 0 });
        await this.bulkInsertUrls(userId, urls);
      // }

      await Client.updateOne(
        { userId },
        { $inc: { "pagesAdded.total": urls.length || 0 } }
      );

      await urlProcessingQueue.add("processSingleUrl", {
        urls,
        userId,
        qdrantIndexName,
        plan,
        sitemapUrl:true,
      });


      res.json({
        success: true,
        // message: "Scraping sta successfully",
      });
    } catch (error) {
      const { userId } = req.body;
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        message: error.message,
        client: await Client.findOne({ userId }),
      });
      console.error("Error starting sitemap scraping:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  // Upgrade plan and continue scraping
  async ContinueScrappingAfterUpgrade(req, res) {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId",
        });
      }

      const client = await Client.findOne({ userId });
      if (!client) {
        return res.status(404).json({
          success: false,
          error: "Client not found",
        });
      }
      const qdrantIndexName =
        client?.plan == "free"
          ? client?.qdrantIndexName
          : client?.qdrantIndexNamePaid;
      const plan = await PlanService.getUserPlan(userId);

      const remainingUrls = await Url.distinct("url", {
        userId: userId,
        trainStatus: 0,
      });
      if (remainingUrls.length <= 0) {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: "No URL found to scrape",
        });
      } else {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 1 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
        });

        await urlProcessingQueue.add("processSingleUrl", {
          urls: remainingUrls,
          userId,
          qdrantIndexName,
          plan,
          sitemapUrl:false,
        });
      }

      res.json({
        success: true,
        // message: "Plan upgraded and scraping continued",
      });
    } catch (error) {
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
        message: error.message,
      });
      console.error("Error upgrading plan and continuing scraping:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  // Upgrade plan
  async upgradePlan(req, res) {
    try {
      const { userId, newPlan } = req.body;

      if (!userId || !newPlan) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId, newPlan",
        });
      }

      // Upgrade the plan
      const upgradeSuccess = await PlanService.upgradePlan(userId, newPlan);
      if (!upgradeSuccess) {
        return res.status(500).json({
          success: false,
          error: "Failed to upgrade plan",
        });
      }

      const updatedPlan = await PlanService.getUserPlan(userId);

      res.json({
        success: true,
        message: "Plan upgraded",
        data: {
          planInfo: {
            name: updatedPlan.name,
            maxPages: updatedPlan.maxPages,
            maxStorage: updatedPlan.maxStorage,
          },
        },
      });
    } catch (error) {
      console.error("Error upgrading plan and continuing scraping:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  // Get scraping history
  async getScrapingHistory(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20, type = null, status = null } = req.query;

      const TrainingModel = await PlanService.getTrainingModel(userId);

      const query = { userId };
      // Handle sourceType filter from frontend
      let filterType = null;
      switch (type) {
        case "Web Pages":
          filterType = 0;
          break;
        case "Files":
          filterType = 1;
          break;
        case "Doc/Snippets":
          filterType = 2;
          break;
        case "FAQs":
          filterType = 3;
          break;
        case "all":
        default:
          filterType = null;
      }

      if (filterType !== null) {
        query.type = filterType;
      }
      if (status !== null) {
        if (status === "success") {
          query.trainingStatus = 1; // Completed
        } else if (status === "failed") {
          query.trainingStatus = 2; // Failed, Insufficient Credits, Plan Upgrade Required
        } else {
          query.trainingStatus = { $in: [1, 2] };
        }
      }

      const skip = (page - 1) * limit;

      const [entries, total] = await Promise.all([
        TrainingModel.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        TrainingModel.countDocuments(query),
      ]);

      res.json({
        success: true,
        data: {
          entries,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error("Error getting scraping history:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  async getScrapingHistoryBySocket(userId, skip, limit, type, status) {
    try {
      const TrainingModel = await PlanService.getTrainingModel(userId);

      const query = { userId };
      // Handle sourceType filter from frontend
      let filterType = null;
      switch (type) {
        case "Web Pages":
          filterType = 0;
          break;
        case "Files":
          filterType = 1;
          break;
        case "Doc/Snippets":
          filterType = 2;
          break;
        case "FAQs":
          filterType = 3;
          break;
        case "all":
        default:
          filterType = null;
      }

      if (filterType !== null) {
        query.type = filterType;
      }
      if (status !== null) {
        if (status === "success") {
          query.trainingStatus = 1; // Completed
        } else if (status === "failed") {
          query.trainingStatus = 2; // Failed, Insufficient Credits, Plan Upgrade Required
        } else {
          query.trainingStatus = { $in: [0, 1, 2] };
        }
      }

      const [entries, total] = await Promise.all([
        TrainingModel.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        TrainingModel.countDocuments(query),
      ]);

      return {
        success: true,
        data: {
          entries,
          pagination: {
            // page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        },
      };
    } catch (error) {
      console.error("Error getting scraping history:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async createSnippet(req, res) {
    try {
      const { title, content } = req.body;
      const file = req.file;
      const userId = req.body.userId;

      const client = await Client.findOne({ userId });
      if (!client) {
        return res
          .status(404)
          .json({ status: false, message: "Client not found" });
      }

      const qdrantIndexName =
        client?.plan == "free"
          ? client?.qdrantIndexName
          : client?.qdrantIndexNamePaid;

      const TrainingModel = await PlanService.getTrainingModel(userId);

      let documentsToProcess = [];
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 1 } });

      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
      });

      // Process snippet if provided
      if (title && content) {
        // Validate snippet content
        const snippetValidation =
          await ContentValidationService.validateContent(
            content,
            "snippet",
            userId
          );

        if (!snippetValidation.isValid) {
          await Client.updateOne(
            { userId },
            { $set: { dataTrainingStatus: 0 } }
          );
          appEvents.emit("userEvent", userId, "training-event", {
            client: await Client.findOne({ userId }),
            message: snippetValidation.error,
          });
          return res.status(400).json({
            status: false,
            // message: snippetValidation.error,
            errorCode: snippetValidation.errorCode,
            field: "content",
          });
        }

        const trainingList = new TrainingModel({
          userId,
          title,
          type: 2, // Snippet
          content: snippetValidation.cleanContent,
          trainingStatus: 0, // Not Started
          dataSize: snippetValidation.contentSize,
          chunkCount: 0,
          // wordCount: snippetValidation.wordCount,
          // estimatedTokens: snippetValidation.estimatedTokens,
          // },
        });

        await trainingList.save();

        documentsToProcess.push({
          type: 2,
          content: snippetValidation.cleanContent,
          metadata: {
            title: title,
            type: "snippet",
            user_id: userId,
            // plan: plan.name,
            // wordCount: snippetValidation.wordCount,
            // estimatedTokens: snippetValidation.estimatedTokens,
          },
        });
      }

      // Process file if provided
      if (file) {
        try {
          const fileContent = await readFileContent(file.path, file.mimetype);

          // Validate file content
          const fileValidation = await ContentValidationService.validateFile(
            fileContent,
            file.originalname,
            userId
          );

          if (!fileValidation.isValid) {
            await Client.updateOne(
              { userId },
              { $set: { dataTrainingStatus: 0 } }
            );
            appEvents.emit("userEvent", userId, "training-event", {
              client: await Client.findOne({ userId }),
              message: fileValidation.error,
            });
            return res.status(400).json({
              status: false,
              // message: fileValidation.error,
              errorCode: fileValidation.errorCode,
              field: "file",
            });
          }

          const trainingList = new TrainingModel({
            userId,
            title: file.originalname.toString(),
            type: 1, // File
            fileContent: fileValidation.cleanContent.toString(),
            fileName: file.filename.toString(),
            originalFileName: file.originalname.toString(),
            trainingStatus: 0, // Not Started
            dataSize: fileValidation.contentSize,
            chunkCount: 0,
            // wordCount: fileValidation.wordCount,
            // estimatedTokens: fileValidation.estimatedTokens,
            // fileExtension: fileValidation.fileExtension,
            // },
          });

          await trainingList.save();

          documentsToProcess.push({
            type: 1,
            content: fileValidation.cleanContent,
            metadata: {
              title: file.originalname,
              fileName: file.filename,
              originalFileName: file.originalname,
              type: "file",
              user_id: userId,
              // plan: plan.name,
              // wordCount: fileValidation.wordCount,
              // estimatedTokens: fileValidation.estimatedTokens,
              // fileExtension: fileValidation.fileExtension,
            },
          });
        } catch (fileError) {
          await Client.updateOne(
            { userId },
            { $set: { dataTrainingStatus: 0 } }
          );
          appEvents.emit("userEvent", userId, "training-event", {
            client: await Client.findOne({ userId }),
            message: fileError.message,
          });
          console.error("Error processing file:", fileError);
          return res.status(400).json({
            status: false,
            message: "Failed to process file content",
            errorCode: "FILE_PROCESSING_ERROR",
            error: fileError.message,
          });
        }
      }

      if (!documentsToProcess.length) {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: "No document found to process ",
        });
        return res.status(400).json({
          status: false,
          message: "No valid content provided for processing",
          errorCode: "NO_CONTENT",
        });
      }

      const batchService = new batchTrainingService();

      let result = await batchService.processDocumentAndTrain(
        documentsToProcess,
        userId,
        qdrantIndexName,
        false
      );
      if (result.success) {
        await TrainingModel.findOneAndUpdate(
          { userId: userId, title: title || file.originalname },
          {
            trainingStatus: 1, // Completed
            chunkCount: result.totalChunks,
            lastEdit: Date.now(),
          }
        );
        await Client.updateOne({ userId: userId }, { $inc: { filesAdded: 1 } });

        // Update client flags
        await Client.updateOne({ userId: userId }, { dataTrainingStatus: 0 });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
        });
      } else {
        await TrainingModel.findByIdAndUpdate(
          { userId: userId, title: title || file.originalname },
          {
            trainingStatus: 2, // Error
            lastEdit: Date.now(),
            error: result.error,
          }
        );
        // Update client flags
        await Client.updateOne({ userId: userId }, { dataTrainingStatus: 0 });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: "Data training failed",
        });
      }

      res.status(201).json({
        status_code: 200,
        // message: "Documents validated and queued for processing successfully",
      });
    } catch (error) {
      const userId = req.body.userId;
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
        message: error.message,
      });
      console.error("Error in createSnippet:", error);
      res.status(500).json({
        status: false,
        message: "Failed to process documents",
        errorCode: "INTERNAL_ERROR",
        error: error.message,
      });
    }
  }

  // Updated createFaq with validation
  async createFaq(req, res) {
    const { question, answer } = req.body;
    const userId = req.body.userId;

    try {
      const client = await Client.findOne({ userId });
      if (!client) {
        return res
          .status(404)
          .json({ status: false, message: "Client not found" });
      }

      const qdrantIndexName =
        client?.plan == "free"
          ? client?.qdrantIndexName
          : client?.qdrantIndexNamePaid;

      const TrainingModel = await PlanService.getTrainingModel(userId);
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 1 } });

      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
      });

      // Validate FAQ content
      const faqValidation = await ContentValidationService.validateFAQ(
        question,
        answer,
        userId
      );

      if (!faqValidation.isValid) {
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: faqValidation.error,
        });
        return res.status(400).json({
          status: false,
          // message: faqValidation.error,
          errorCode: faqValidation.errorCode,
          field: faqValidation.field,
          // details: {
          //   currentLength: faqValidation.currentLength,
          //   requiredLength: faqValidation.requiredLength,
          //   sizeInfo: faqValidation.sizeInfo,
          // },
        });
      }

      const trainingList = new TrainingModel({
        userId,
        title: question,
        type: 3, // FAQ
        content: faqValidation.cleanContent,
        trainingStatus: 0, // Not Started
        dataSize: faqValidation.contentSize,
        metadata: {
          chunkCount: 0,
        },
      });

      await trainingList.save();

      const document = [{
        type: 3,
        content: faqValidation.cleanContent,
        metadata: {
          title: question,
          question: question,
          answer: answer,
          type: "faq",
          user_id: userId,
          // plan: plan.name,
          // wordCount: faqValidation.wordCount,
          // estimatedTokens: faqValidation.estimatedTokens,
        },
      }];

      const batchService = new batchTrainingService();

      // processDocumentAndTrain(document, userId, qdrantIndexName, false)
      let result = await batchService.processDocumentAndTrain(
        document,
        userId,
        qdrantIndexName,
        false
      );
      if (result.success) {
        await TrainingModel.findOneAndUpdate(
          { userId: userId, title: question },
          {
            trainingStatus: 1, // Completed
            chunkCount: result.totalChunks,
            lastEdit: Date.now(),
          }
        );
        await Client.updateOne({ userId: userId }, { $inc: { faqsAdded: 1 } });

        // Update client flags
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });

        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
        });
      } else {
        await TrainingModel.findByIdAndUpdate(
          { userId: userId, title: question },
          {
            trainingStatus: 2, // Error
            lastEdit: Date.now(),
            error: result?.error,
          }
        );

        // Update client flags
        await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });

        appEvents.emit("userEvent", userId, "training-event", {
          client: await Client.findOne({ userId }),
          message: "failed to train data",
        });
      }

      res.status(201).json({
        status_code: 200,
        message: "FAQ validated and queued for processing successfully",
      });
    } catch (error) {
      await Client.updateOne({ userId }, { $set: { dataTrainingStatus: 0 } });

      appEvents.emit("userEvent", userId, "training-event", {
        client: await Client.findOne({ userId }),
        message: error.message,
      });

      console.error("Error in createFaq:", error);
      res.status(500).json({
        status: false,
        message: "Failed to create FAQ",
        errorCode: "INTERNAL_ERROR",
        error: error.message,
      });
    }
  }

  async getFiledData(req, res) {
    try {
      const id = req.params.id;
      const { userId } = req.body;
      const TrainingModel = await PlanService.getTrainingModel(userId);
      let data = await TrainingModel.findOne({ _id: id });

      if (!data) {
        return res.status(404).json({
          status: false,
          message: `HTTP error! status: 404 - Data not found`,
        });
      }

      res.status(200).json({
        status: true,
        data: data,
      });
    } catch (error) {
      res.status(500).json({
        status: false,
        message: `HTTP error! status: 500 - Error in Data field`,
        error: error.message,
      });
    }
  }
}

module.exports = new ScrapingController();
