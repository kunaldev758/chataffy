// services/scrapingHelpers.js
const Sitemap = require("../models/Sitemap");
const TrainingList = require("../models/OpenaiTrainingList");

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
  await Promise.all(existingRecords.map((record) => record.save())); // Save concurrently
  return { insertedRecords, updatedRecords, duplicateRecords };
}

async function createTrainingListAndWebPages(urls, userId, sitemapId) {
  try {
    const trainingListDocuments = urls.map((url) => ({
      userId: userId,
      title: url,
      type: 0,
      webPage: {
        url,
        sitemapIds: [sitemapId],
      },
      trainingStatus: 1,
    }));

    await TrainingList.insertMany(trainingListDocuments);
  } catch (error) {
    console.error("Error inserting data:", error);
    throw error; // Re-throw to signal failure
  }
}

module.exports = {
  insertOrUpdateSitemapRecords,
  createTrainingListAndWebPages,
};