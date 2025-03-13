/* OpenAI */
require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const Client = require("../models/Client");
const Sitemap = require("../models/Sitemap");
const TrainingList = require("../models/OpenaiTrainingList");

const webPageQueue = require("../services/webPageCrawler");

const commonHelper = require("../helpers/commonHelper.js");
const ObjectId = require("mongoose").Types.ObjectId;

const OpenaiTrainingListController = {};

// Update createFaq method
OpenaiTrainingListController.createFaq = async (req, res) => {
  const { question, answer } = req.body;
  const userId = req.body.userId;

  try {
    const client = await Client.findOne({ userId });
    if (!client) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }
    const pineconeIndexName = client.pineconeIndexName;

    const content = `Question: ${question}\nAnswer: ${answer}`;
    // let contentProcessor = new ContentProcessor(pineconeIndexName);
    const result = await processFileOrSnippet({
      title: question,
      content,
      userId,
    });

    if (result.success) {
      const trainingList = new TrainingList({
        userId,
        title: question,
        type: 1,
        faq: { question, answer },
        costDetails: result.costs,
      });
      await trainingList.save();

      await Client.updateOne({ id: userId }, { faqAdded: true });
      req.io.to('user'+userId).emit('faq-added', { trainingList }); // Emit FAQ added event
      res
        .status(201)
        .json({ status_code: 200, message: "FAQ added successfully" });
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error in createFaq:", error);
    res.status(500).json({ status: false, message: "Failed to create FAQ" });
  }
};

// Updated scraping method
OpenaiTrainingListController.scrape = async (req, res) => {
  const { sitemap } = req.body;
  const userId = req.body.userId;
  try {
    const client = await Client.findOne({userId});

    if(!client) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }

    const pineconeIndexName = client.pineconeIndexName;

    if(client.sitemapScrappingStatus + client.webPageScrappingStatus == 0) {
      const existingSitemap = await Sitemap.findOne({ userId, url: sitemap });
      if (existingSitemap) {
        res.status(200).json({ status_code: 200, message: "Sitemap already added." });
      } else {
        // Create Sitemap
        let sitemapObj = await Sitemap.create({userId, url: sitemap });
        res.status(201).json({ status_code: 200, message: "Scraping process initiated." });
        client.sitemapScrappingStatus = 1;
        await client.save();
        // Recursive function to scrape nested sitemaps
        while(sitemapObj) {
          try {
            let config = {
              method: 'get',
              maxBodyLength: Infinity,
              url: sitemapObj.url,
              headers: { }
            };
            const sitemapResponse = await axios.request(config);
            const $ = cheerio.load(sitemapResponse.data);

            const webPageLocs = $("loc:not(sitemap loc)")
              .map((index, element) => $(element).text())
              .get(); ;  
            if(webPageLocs.length) {
              const trainingListIds = await createTrainingListAndWebPages(webPageLocs, userId, sitemapObj._id);
              req.io.to('user'+userId).emit('web-pages-added');
               // Add web pages to queue using bullmq
               for (const trainingListId of trainingListIds) {
                await webPageQueue.add('webPageScraping', { trainingListId, pineconeIndexName }); // Job Name and data
              }
            }

            // const delayInMilliseconds = 1000;
            const sitemapLocs = $("sitemap loc")
              .map((index, element) => $(element).text())
              .get();
            if(sitemapLocs.length) {
              const insertedSitemaps = await insertOrUpdateSitemapRecords(sitemapLocs, userId, sitemapObj._id);
            }
          }
          catch(error) {
            console.log("Error in scrapping "+sitemapObj.url);
            console.log(error);
          }
          sitemapObj.status = 1;
          await sitemapObj.save();
          sitemapObj = await Sitemap.findOne({ userId, status: 0 });
        } // Loop end
        client.sitemapScrappingStatus = 0;
        await client.save();
      }
    }
    else if(client.sitemapScrappingStatus == 1) {
      res.status(200).json({ status_code: 200, message: "Sitemap scrapping already in progress" });
    }
    else if(client.webPageScrappingStatus == 1) {
      res.status(200).json({ status_code: 200, message: "Web-page scrapping already in progress" });
    }
  } catch (error) {
    console.error(error);
    // Emit socket event: Scraping failed
    req.io.emit("scrapingFailed", { message: "Scraping process failed." });
  }
};


async function insertOrUpdateSitemapRecords(urls, userId, sitemapId) {
  const insertedRecords = [];
  const updatedRecords = [];
  const duplicateRecords = [];

  const existingRecords = await Sitemap.find({ url: { $in: urls }, userId });

  for (const url of urls) {
    const existingRecord = existingRecords.find((record) => record.url === url);

    if (existingRecord) {
      if (!existingRecord.parentSitemapIds.includes(sitemapId)) {
        existingRecord.parentSitemapIds.push(sitemapId);
        updatedRecords.push(existingRecord);
      } else {
        duplicateRecords.push(existingRecord._id);
      }
    } else {
      const sitemap = new Sitemap({
        userId,
        url,
        parentSitemapIds: [sitemapId],
      });
      await sitemap.save();
      insertedRecords.push(sitemap);
    }
  }
  // Save changes to existing records concurrently
  await Promise.all(existingRecords.map((record) => record.save()));
  return { insertedRecords, updatedRecords, duplicateRecords };
}

async function createTrainingListAndWebPages(urls, userId, sitemapId) {
  try {
    const trainingListIds = [];
    // Step 1: Insert into TrainingList
    for (const url of urls) {
      const trainingListObj = await TrainingList.create({
        userId: userId,
        title: url,
        type: 0,
  
        webPage: {
          url,
          sitemapIds: [sitemapId],
        },
      });
      trainingListIds.push(trainingListObj._id);
    }
    return trainingListIds;
  } catch (error) {
    console.error("Error inserting data:", error);
  }
}

// Updated createSnippet method
OpenaiTrainingListController.createSnippet = async (req, res) => {
  try {
    const { title, content } = req.body;
    const file = req.file;
    const userId = req.body.userId;

    const client = await Client.findOne({ userId });
    if (!client) {
      return res.status(404).json({ status: false, message: "Client not found" });
    }

    const pineconeIndexName = client.pineconeIndexName;

    // let contentProcessor = new ContentProcessor(pineconeIndexName);
    let results = [];

    if (title && content) {
      const snippetResult = await contentProcessor.processFileOrSnippet({
        title,
        content,
        userId,
      });

      if (snippetResult.success) {
        const trainingList = new TrainingList({
          userId,
          title,
          type: 2,
          snippet: { title, content },
          costDetails: snippetResult.costs,
        });
        await trainingList.save();
        results.push({ type: "snippet", success: true });
        req.io.to('user'+userId).emit('doc-snippet-added', { trainingList }); // Emit doc/snippet added event
      }
    }

    if (file) {
      const fileResult = await contentProcessor.processFileOrSnippet({
        file,
        userId,
      });

      if (fileResult.success) {
        const fileContent = await contentProcessor.readFileContent(
          file.path,
          file.mimetype
        );
        const trainingList = new TrainingList({
          userId,
          title: file.originalname,
          type: 3,
          file: {
            fileName: file.filename,
            originalFileName: file.originalname,
            path: file.path,
            content: fileContent,
          },
          costDetails: fileResult.costs,
        });
        await trainingList.save();
        results.push({ type: "file", success: true });
        req.io.to('user'+userId).emit('doc-snippet-added', { trainingList }); // Emit doc/snippet added event
      }
    }

    if (results.length > 0) {
      await Client.updateOne({ id: userId }, { docSnippetAdded: true });
      res
        .status(201)
        .json({
          status_code: 200,
          message: "Documents processed successfully",
        });
    } else {
      throw new Error("No content processed successfully");
    }
  } catch (error) {
    console.error("Error in createSnippet:", error);
    res.status(500).json({ message: "Failed to process documents" });
  }
};

OpenaiTrainingListController.getTrainingListDetail = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { id } = req.body;
    const trainingList = await TrainingList.findById(id);
    if (!trainingList) {
      res
        .status(200)
        .json({ status: false, message: "No matching record found" });
      return;
    }
    if (trainingList.userId != userId) {
      res
        .status(200)
        .json({ status: false, message: "Not authorised for this training" });
      return;
    }
    res.status(200).json(trainingList);
  } catch (error) {
    commonHelper.logErrorToFile(error);
    res
      .status(500)
      .json({
        status: false,
        message: "Something went wrong please try again!",
      });
  }
};



OpenaiTrainingListController.getWebPageUrlCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: { userId: new ObjectId(userId), type: 0 },
      },
      {
        $group: {
          _id: null,
          totalUrlCount: { $sum: 1 },
          crawledPagesCount: {
            $sum: {
              $cond: {
                if: { $eq: ["$trainingProcessStatus.crawlingStatus", 2] },
                then: 1,
                else: 0,
              },
            },
          },
          mappedPagesCount: {
            $sum: {
              $cond: {
                if: { $eq: ["$trainingProcessStatus.mappingStatus", 2] },
                then: 1,
                else: 0,
              },
            },
          },
        },
      },
    ]).exec();

    const counts =
      result.length > 0
        ? result[0]
        : { totalUrlCount: 0, crawledPagesCount: 0, mappedPagesCount: 0 };
    // console.log(result, counts);
    return {
      totalPages: counts.totalUrlCount,
      crawledPages: counts.crawledPagesCount,
      mappedPages: counts.mappedPagesCount,
    };
  } catch (error) {
    console.log("Error in getWebPageUrlCount.");
    // return res
    //   .status(500)
    //   .json({ status_code: 500, status: false, message: "Please try again!" });
  }
};

// Counting snippets and files both
OpenaiTrainingListController.getSnippetCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: {
          userId: new ObjectId(userId),
          type: { $in: [2, 3] },
        },
      },
      {
        $group: {
          _id: null,
          totalDocs: { $sum: 1 },
          crawledDocs: {
            $sum: {
              $cond: { if: { $eq: ["$trainingStatus", 4] }, then: 1, else: 0 },
            },
          },
        },
      },
    ]).exec();

    const counts =
      result.length > 0 ? result[0] : { crawledDocs: 0, totalDocs: 0 };
    // console.log(result, counts);
    return {
      crawledDocs: counts.crawledDocs,
      totalDocs: counts.totalDocs,
    };
  } catch (error) {
    console.log("Error in getSnippetCount.");
    // return res
    //   .status(500)
    //   .json({ status_code: 500, status: false, message: "Please try again!" });
  }
};
OpenaiTrainingListController.getFaqCount = async (userId) => {
  try {
    const result = await TrainingList.aggregate([
      {
        $match: { userId: new ObjectId(userId), type: 1 },
      },
      {
        $group: {
          _id: null,
          totalFaqs: { $sum: 1 },
          crawledFaqs: {
            $sum: {
              $cond: { if: { $eq: ["$trainingStatus", 4] }, then: 1, else: 0 },
            },
          },
        },
      },
    ]).exec();

    const counts =
      result.length > 0 ? result[0] : { crawledFaqs: 0, totalFaqs: 0 };
    // console.log(result, counts);
    return {
      crawledFaqs: counts.crawledFaqs,
      totalFaqs: counts.totalFaqs,
    };
  } catch (error) {
    console.log("Error in getFaqCount.");
    // return res
    //   .status(500)
    //   .json({ status_code: 500, status: false, message: "Please try again!" });
  }
};

OpenaiTrainingListController.getWebPageList = async (
  userId,
  skip,
  limit,
  sourcetype,
  actionType
) => {
  try {
    let isActive = 0;
    let type = 1;
    switch (actionType) {
      case "Action 1":
        isActive = 1;
        break;
      case "Action 2":
        isActive = 0;
        break;
      default:
        isActive = 0;
    }

    switch (sourcetype) {
      case "Show All Sources":
        type = 1;
        break;
      case "Web Pages":
        type = 0;
        break;
      case "Doc/Snippets":
        type = 2;
        break;
      case "FAQs":
        type = 1;
        break;
      default:
        type = 1;
    }

    const webPages = await TrainingList.aggregate([
      {
        $match: {
          userId: new ObjectId(userId),
        },
      },
      {
        $project: {
          title: 1,
          type: type,
          isActive: isActive,
          lastEdit: {
            $dateToString: {
              format: "%B %d, %Y",
              date: "$lastEdit",
              timezone: "UTC", // Adjust the timezone if needed
            },
          },
          timeUsed: 1,
          crawlingStatus: "$trainingProcessStatus.crawlingStatus",
          isActive: 1,
          trainingStatus: 1,
        },
      },
      {
        $skip: skip, // Skip documents for the previous pages
      },
      {
        $limit: limit, // Limit the number of documents returned
      },
    ]);
    return webPages;
  } catch (error) {
    console.log(error);
    throw new Error("Please try again!");
  }
};

OpenaiTrainingListController.toggleActiveStatus = async (req, res) => {
  const { id } = req.body;
  try {
    await TrainingList.findByIdAndUpdate(id, {
      $bit: { isActive: { xor: 1 } },
    });
    res.status(201).json({ status_code: 200, message: "Status changed." });
  } catch (error) {
    console.log("Error in status change");
    console.log(error);
  }
};

OpenaiTrainingListController.getTrainingStatus = async (req, res) => {
  const clientId = req.body.userId;
  try {
    const data = await Client.findOne({ userId: clientId });
    res.status(200).send({
      webpageStatus: data.webPageAdded,
      faqStatus: data.faqAdded,
      docSnippetStatus: data.docSnippetAdded,
    });
  } catch (err) {
    res.status(500).send({ message: "Error in fetching status" });
  }
};

module.exports = OpenaiTrainingListController;