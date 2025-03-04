// services/scrapingService.js
const { webPageCrawling } = require("./webPageCrawler");
const { webPageMinifying } = require("./webPageMinifier");
const { scrapeSitemap } = require("./sitemapScraper");
const Client = require("../models/Client");
const ObjectId = require("mongoose").Types.ObjectId;
const TrainingList = require("../models/OpenaiTrainingList");
const { emitSocketEvent } = require("../helpers/socketHelper");
const scrapeQueue = require("../queue/scrapeQueue");

const clientStatus = {};

// ====================
//  Webpage Scraping Logic
// ====================
async function webPageCrawlingProcess(client, userId, io, pineconeIndexName) {
  try {
    if (clientStatus[userId] && clientStatus[userId].webPageCrawling) {
      return;
    }
    clientStatus[userId] = { webPageCrawling: true };
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        trainingStatus: 1,
      }).limit(10);

      await Promise.all(
        trainingListObjArray.map(async (trainingListObj) => {
          // Enqueue crawlWebPage job
          await TrainingList.findByIdAndUpdate(trainingListObj._id, {
            "trainingProcessStatus.crawlingStatus": 1,
            "trainingProcessStatus.crawlingDuration.start": Date.now(),
          });
          emitSocketEvent(io, userId, "webPageCrawlingStarted", {
            trainingListId: trainingListObj._id,
          });

          await scrapeQueue.add("crawlWebPage", {
            type: "crawlWebPage",
            data: { trainingListObj },
            userId,
            pineconeIndexName,
            io,
          });
        })
      );

      if (trainingListObjArray.length) {
        const updatedCrawledCount = await TrainingList.countDocuments({
          userId: new ObjectId(userId),
          type: 0,
          "trainingProcessStatus.crawlingStatus": 2,
        }).exec();
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({
          _id,
          trainingStatus,
        }));
        emitSocketEvent(io, userId, "webPagesCrawled", {
          updatedCrawledCount,
          list,
        });

        webPageMinifyingProcess(client, userId, io, pineconeIndexName);
      }
    } while (trainingListObjArray.length > 0); // Loop end
    clientStatus[userId] = { webPageCrawling: false };
  } catch (error) {
    console.error("Error in webpage scrapping", error);
    clientStatus[userId] = { webPageCrawling: false };
  }
}

async function webPageMinifyingProcess(client, userId, io, pineconeIndexName) {
  try {
    if (clientStatus[userId] && clientStatus[userId].webPageMinifying) {
      return;
    }
    clientStatus[userId] = { webPageMinifying: true };
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        // 'webPage.crawlingStatus': 2,
        trainingStatus: 2,
      }).limit(10);

      await Promise.all(
        trainingListObjArray.map(async (trainingListObj) => {
          await scrapeQueue.add("minifyWebPage", {
            type: "minifyWebPage",
            data: { trainingListObj },
            userId,
            pineconeIndexName,
            io,
          });
        })
      );

      if (trainingListObjArray.length) {
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({
          _id,
          trainingStatus,
        }));
        emitSocketEvent(io, userId, "webPagesMinified", {
          list,
        });

        // webPageMapping(client, userId, req);
      }
    } while (trainingListObjArray.length > 0);
    clientStatus[userId] = { webPageMinifying: false };
  } catch (error) {
    console.error("Error in webpage mapping", error);
    clientStatus[userId] = { webPageMinifying: false };
  }
}

module.exports = {
  scrapeSitemap,
  webPageCrawlingProcess,
  webPageMinifyingProcess,
};