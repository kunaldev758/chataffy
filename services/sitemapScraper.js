// services/sitemapScraper.js
const axios = require("axios");
const cheerio = require("cheerio");
const { emitSocketEvent } = require("../helpers/socketHelper");
const {
  insertOrUpdateSitemapRecords,
  createTrainingListAndWebPages,
} = require("./scrapingHelpers");

async function scrapeSitemap(sitemapUrl, userId, io) {
  try {
    emitSocketEvent(io, userId, "scrapingSitemapStarted", { sitemapUrl });

    const config = {
      method: "get",
      maxBodyLength: Infinity,
      url: sitemapUrl,
      headers: {},
    };
    const sitemapResponse = await axios.request(config);
    const $ = cheerio.load(sitemapResponse.data);

    const webPageLocs = $("loc:not(sitemap loc)")
      .map((index, element) => $(element).text())
      .get();

    if (webPageLocs.length) {
      await createTrainingListAndWebPages(webPageLocs, userId, sitemapUrl);
      emitSocketEvent(io, userId, "webPagesAdded", {
        count: webPageLocs.length,
      });
    }

    const sitemapLocs = $("sitemap loc")
      .map((index, element) => $(element).text())
      .get();

    if (sitemapLocs.length) {
      await insertOrUpdateSitemapRecords(sitemapLocs, userId, sitemapUrl);
    }

    emitSocketEvent(io, userId, "scrapingSitemapCompleted", { sitemapUrl });

    return { success: true, webPageCount: webPageLocs.length };
  } catch (error) {
    console.error(`Error scraping sitemap ${sitemapUrl}:`, error);
    emitSocketEvent(io, userId, "scrapingSitemapFailed", {
      sitemapUrl,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

module.exports = { scrapeSitemap };