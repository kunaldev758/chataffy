// services/webPageCrawler.js
const axios = require("axios");
const { emitSocketEvent } = require("../helpers/socketHelper");
const TrainingList = require("../models/OpenaiTrainingList");

async function crawlWebPage(trainingListObj, io) {
  const userId = trainingListObj.userId;
  const trainingListId = trainingListObj._id;

  try {
    emitSocketEvent(io, userId, "webPageCrawlingStarted", { trainingListId });

    const config = {
      method: "get",
      maxBodyLength: Infinity,
      url: trainingListObj.webPage.url,
      headers: {},
    };

    const response = await axios.request(config);

    await TrainingList.findByIdAndUpdate(trainingListId, {
      "webPage.sourceCode": response.data,
      "trainingProcessStatus.crawlingStatus": 2,
      "trainingProcessStatus.crawlingDuration.end": Date.now(),
      trainingStatus: 2,
    });
    emitSocketEvent(io, userId, "webPageCrawled", { trainingListId });
    return { success: true };
  } catch (error) {
    console.error(`Error crawling ${trainingListObj.webPage.url}:`, error);
    await TrainingList.findByIdAndUpdate(trainingListId, {
      "trainingProcessStatus.crawlingStatus": 3,
      lastEdit: Date.now(),
      trainingStatus: 9,
    });
    emitSocketEvent(io, userId, "webPageCrawlingFailed", {
      trainingListId,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

module.exports = { crawlWebPage };