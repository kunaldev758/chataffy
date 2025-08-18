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

  async extractUrlsFromSitemap(sitemapUrl) {
    try {
      const response = await axios.get(sitemapUrl, {
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
        },
      });

      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(response.data);

      let urls = [];

      // Handle regular sitemap
      if (result.urlset && result.urlset.url) {
        urls = result.urlset.url.map((urlObj) => urlObj.loc[0]);
      }

      // Handle sitemap index
      else if (result.sitemapindex && result.sitemapindex.sitemap) {
        const sitemapUrls = result.sitemapindex.sitemap.map(
          (sitemapObj) => sitemapObj.loc[0]
        );

        // Recursively fetch URLs from each sitemap
        for (const nestedSitemapUrl of sitemapUrls) {
          try {
            const nestedUrls = await this.extractUrlsFromSitemap(
              nestedSitemapUrl
            );
            urls.push(...nestedUrls);
          } catch (error) {
            console.error(
              `Error fetching nested sitemap ${nestedSitemapUrl}:`,
              error
            );
          }
        }
      }

      // Filter and clean URLs
      urls = urls
        .filter((url) => url && typeof url === "string")
        .filter((url) => url.startsWith("http"))
        .map((url) => url.trim())
        .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates

      return urls;
    } catch (error) {
      console.error(`Error extracting URLs from sitemap ${sitemapUrl}:`, error);
      throw new Error(`Failed to parse sitemap: ${error.message}`);
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
      for (const url of urls) {
        await Url.create({ userId: userId, url: url, trainStatus: 0 });
      }

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
