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
const cheerio = require("cheerio");
const { urlProcessingQueue, deleteTrainingDataQueue, retrainTrainingDataQueue } = require("../services/jobService.js");
const Agent = require("../models/Agent.js");
const Widget = require("../models/Widget.js");

class ScrapingController {
  constructor() {
    this.startSitemapScraping = this.startSitemapScraping.bind(this);
    this.ContinueScrappingAfterUpgrade =
      this.ContinueScrappingAfterUpgrade.bind(this);
    this.upgradePlan = this.upgradePlan.bind(this);
    this.getScrapingHistory = this.getScrapingHistory.bind(this);
    this.getSitemapUrls = this.getSitemapUrls.bind(this);
  }


  // Method 1: Simple Bulk Insert (Recommended for most cases)
async bulkInsertUrls(userId,agentId, urls) {
  try {
    console.log(`🚀 Bulk inserting ${urls.length} URLs...`);
    const startTime = Date.now();

    const urlDocuments = urls.map(url => ({
      userId: userId,
      agentId: agentId,
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

  async extractUrlsFromSitemap(sitemapUrl) {
    try {
      // Auto-add https:// prefix if protocol is missing
      if (sitemapUrl && typeof sitemapUrl === 'string') {
        const trimmedUrl = sitemapUrl.trim();
        if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
          sitemapUrl = `https://${trimmedUrl}`;
        }
      }

      // If a website URL (not a sitemap) is provided, try to discover sitemaps or fallback to homepage links
      let urls = [];
      let isWebsiteUrl = false;
      let origin = null;
      try {
        const parsed = new URL(sitemapUrl);
        origin = parsed.origin;
        isWebsiteUrl = !parsed.pathname.toLowerCase().endsWith(".xml");
      } catch (_) {
        // Not a valid URL; continue to existing logic which will handle and return []
      }

      if (isWebsiteUrl && origin) {
        console.log(`Website URL provided. Attempting discovery for: ${sitemapUrl}`);

        // 1) robots.txt -> look for Sitemap: entries
        try {
          const robotsResponse = await axios.get(`${origin}/robots.txt`, {
            timeout: 15000,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)" },
            validateStatus: (status) => status < 500,
          });
          if (robotsResponse.status === 200 && typeof robotsResponse.data === "string") {
            const lines = robotsResponse.data.split(/\r?\n/);
            const sitemapLines = lines.filter((l) => /^\s*sitemap\s*:/i.test(l));
            const discoveredSitemaps = sitemapLines
              .map((l) => l.split(":")[1])
              .filter(Boolean)
              .map((v) => v.trim())
              .filter((v) => v.startsWith("http"));

            for (const smUrl of discoveredSitemaps) {
              try {
                const found = await this.extractUrlsFromSitemap(smUrl);
                urls.push(...found);
                if (urls.length >= 10000) break;
              } catch (e) {
                console.warn(`Failed to extract from robots sitemap ${smUrl}: ${e.message}`);
              }
            }

            if (urls.length > 0) {
              // Clean & limit consistent with existing behavior
              const originalCount = urls.length;
              urls = urls
                .filter((url) => url && typeof url === "string")
                .filter((url) => url.startsWith("http"))
                .map((url) => url.trim())
                .filter((url, index, self) => self.indexOf(url) === index);
              console.log(`(robots.txt) Cleaned URLs: ${originalCount} -> ${urls.length}`);
              if (urls.length > 10000) urls = urls.slice(0, 10000);
              return urls;
            }
          }
        } catch (e) {
          console.warn(`robots.txt check failed for ${origin}: ${e.message}`);
        }

        // 2) Try common sitemap locations
        const commonSitemapPaths = [
          "/sitemap.xml",
          "/sitemap_index.xml",
          "/sitemap-index.xml",
          "/sitemap1.xml",
          "/sitemap/sitemap.xml",
          "/sitemap/news.xml",
        ];
        for (const path of commonSitemapPaths) {
          if (urls.length >= 10000) break;
          const candidate = `${origin}${path}`;
          try {
            const found = await this.extractUrlsFromSitemap(candidate);
            urls.push(...found);
          } catch (e) {
            // ignore and try next
          }
        }
        if (urls.length > 0) {
          const originalCount = urls.length;
          urls = urls
            .filter((url) => url && typeof url === "string")
            .filter((url) => url.startsWith("http"))
            .map((url) => url.trim())
            .filter((url, index, self) => self.indexOf(url) === index);
          console.log(`(common paths) Cleaned URLs: ${originalCount} -> ${urls.length}`);
          if (urls.length > 10000) urls = urls.slice(0, 10000);
          return urls;
        }

        // 3) Fallback: extract links from homepage HTML (same-origin, limited)
        try {
          const htmlResponse = await axios.get(sitemapUrl, {
            timeout: 20000,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)" },
            validateStatus: (status) => status < 500,
          });
          if (htmlResponse.status === 200 && typeof htmlResponse.data === "string") {
            const $ = cheerio.load(htmlResponse.data);
            const sameOrigin = new Set();
            $("a[href]").each((_, el) => {
              const href = ($(el).attr("href") || "").trim();
              if (!href) return;
              try {
                const absolute = new URL(href, origin).toString();
                if (absolute.startsWith(origin)) {
                  sameOrigin.add(absolute);
                }
              } catch (_) {}
            });
            urls = Array.from(sameOrigin).slice(0, 500); // conservative cap for homepage crawl

            if (urls.length > 0) {
              const originalCount = urls.length;
              urls = urls
                .filter((url) => url && typeof url === "string")
                .filter((url) => url.startsWith("http"))
                .map((url) => url.trim())
                .filter((url, index, self) => self.indexOf(url) === index);
              console.log(`(homepage) Cleaned URLs: ${originalCount} -> ${urls.length}`);
              if (urls.length > 10000) urls = urls.slice(0, 10000);
              return urls;
            }
          }
        } catch (e) {
          console.warn(`Homepage fallback failed for ${sitemapUrl}: ${e.message}`);
        }

        // If all discovery strategies failed, return empty
        console.warn(`No sitemap or links discovered for website URL: ${sitemapUrl}`);
        return [];
      }

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
      urls = [];
  
      // Handle regular sitemap
      if (result.urlset && result.urlset.url) {
        urls = result.urlset.url.map((urlObj) => urlObj.loc[0]);
        console.log(`Found ${urls.length} URLs in regular sitemap: ${sitemapUrl}`);
        if (urls.length >= 10000) {
          urls = urls.slice(0, 10000); // Take only first 5000 URLs
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
          if (urls.length >= 10000) {
            console.log(`URL limit of 5000 reached. Stopping sitemap processing.`);
            break;
          }
          try {
            const nestedUrls = await this.extractUrlsFromSitemap(nestedSitemapUrl);
            urls.push(...nestedUrls);
            console.log(`Successfully extracted ${nestedUrls.length} URLs from nested sitemap: ${nestedSitemapUrl}`);
            if (urls.length >= 10000) {
              urls = urls.slice(0, 10000); // Trim to exactly 5000 URLs
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

      if (urls.length > 10000) {
        urls = urls.slice(0, 10000);
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

  async fetchBrandColors(websiteUrl) {
    try {
      let normalizedUrl = websiteUrl;
      if (
        normalizedUrl &&
        typeof normalizedUrl === "string" &&
        !normalizedUrl.startsWith("http://") &&
        !normalizedUrl.startsWith("https://")
      ) {
        normalizedUrl = `https://${normalizedUrl.trim()}`;
      }

      const parsed = new URL(normalizedUrl);
      const origin = parsed.origin;

      const response = await axios.get(origin, {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
        },
      });

      if (response.status !== 200 || typeof response.data !== "string") {
        return [];
      }

      const html = response.data;
      const hexMatches = html.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || [];
      const rgbMatches =
        html.match(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)/g) || [];

      const normalizeHex = (value) => {
        if (!value) return null;
        const color = value.trim().toLowerCase();
        if (!color.startsWith("#")) return null;
        if (color.length === 4) {
          return (
            "#" +
            color[1] +
            color[1] +
            color[2] +
            color[2] +
            color[3] +
            color[3]
          );
        }
        if (color.length === 7) return color;
        return null;
      };

      const rgbToHex = (rgb) => {
        const nums = rgb.match(/\d{1,3}/g);
        if (!nums || nums.length < 3) return null;
        const [r, g, b] = nums.slice(0, 3).map((n) => Math.max(0, Math.min(255, Number(n))));
        return (
          "#" +
          [r, g, b]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")
            .toLowerCase()
        );
      };

      const allColors = [
        ...hexMatches.map(normalizeHex).filter(Boolean),
        ...rgbMatches.map(rgbToHex).filter(Boolean),
      ];

      const ignored = new Set(["#fff", "#ffffff", "#000", "#000000", "#f5f5f5", "#fafafa"]);
      const unique = [];
      for (const color of allColors) {
        if (!color || ignored.has(color)) continue;
        if (!unique.includes(color)) {
          unique.push(color);
        }
        if (unique.length >= 6) break;
      }

      return unique;
    } catch (error) {
      console.warn("Failed to fetch brand colors:", error.message);
      return [];
    }
  }

  async fetchLogo(websiteUrl) {
    try {
      let normalizedUrl = websiteUrl;
      if (
        normalizedUrl &&
        typeof normalizedUrl === "string" &&
        !normalizedUrl.startsWith("http://") &&
        !normalizedUrl.startsWith("https://")
      ) {
        normalizedUrl = `https://${normalizedUrl.trim()}`;
      }

      const parsed = new URL(normalizedUrl);
      const origin = parsed.origin;

      const response = await axios.get(origin, {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
        },
      });

      if (response.status !== 200 || typeof response.data !== "string") {
        return null;
      }

      const $ = cheerio.load(response.data);

      const candidates = [
        $('link[rel="apple-touch-icon"]').attr("href"),
        $('link[rel="icon"]').attr("href"),
        $('link[rel="shortcut icon"]').attr("href"),
        $('meta[property="og:image"]').attr("content"),
        $('img[alt*="logo" i]').first().attr("src"),
        $('img[class*="logo" i]').first().attr("src"),
        $('img[id*="logo" i]').first().attr("src"),
      ].filter(Boolean);

      for (const candidate of candidates) {
        try {
          return new URL(candidate, origin).toString();
        } catch (_) {
          // Skip invalid candidate URLs
        }
      }

      return null;
    } catch (error) {
      console.warn("Failed to fetch logo:", error.message);
      return null;
    }
  }

  async getSitemapUrls(req, res) {
    try {
      const { userId, sitemapUrl, agentId, skipBulkInsert } = req.body;
      if (!userId || !agentId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId, agentId",
        });
      }

      if (!sitemapUrl) {
        return res.status(400).json({
          success: false,
          error: "sitemapUrl must be provided",
        });
      }

      const agent = await Agent.findOne({ _id: agentId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
        });
      }
      if (!skipBulkInsert && agent.isSitemapAdded == true && sitemapUrl) {
        return res.status(400).json({
          success: false,
          error: "one sitemap already added",
        });
      }

      let urls = [];
      if (sitemapUrl) {
        urls = await this.extractUrlsFromSitemap(sitemapUrl);
        console.log(`Found ${urls.length} URLs in sitemap`);
      }

      const [brandColors, logo] = await Promise.all([
        this.fetchBrandColors(sitemapUrl),
        this.fetchLogo(sitemapUrl),
      ]);

      const widgetUpdateData = {};
      if (logo) {
        widgetUpdateData.logo = logo;
      }

      if (brandColors.length > 0) {
        const colorFieldNames = [
          "title_bar",
          "title_bar_text",
          "visitor_bubble",
          "visitor_bubble_text",
          "ai_bubble",
          "ai_bubble_text",
        ];

        widgetUpdateData.colorFields = colorFieldNames.map((name, index) => ({
          id: index + 1,
          name,
          value: brandColors[index] || brandColors[0],
        }));
      }

      if (Object.keys(widgetUpdateData).length > 0) {
        await Widget.updateOne(
          { agentId },
          {
            $set: widgetUpdateData,
          }
        );
      }

      if (!skipBulkInsert) {
        await Agent.updateOne({ 
          _id: agentId 
        }, { 
          $set: { 
            isSitemapAdded: true,
          } 
        });
        await this.bulkInsertUrls(userId, agentId, urls);
      }
      
      res.json({
        success: true,
        urls: urls,
      });
    } catch (error) {
      console.error("Error starting sitemap urls:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        urls: [],
      });
    }
  }

  // Start sitemap scraping
  async startSitemapScraping(req, res) {
    try {
      const { userId, urls, agentId } = req.body;
      if (!userId || !agentId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId, agentId",
        });
      }

      if (!urls) {
        return res.status(400).json({
          success: false,
          error: "urls must be provided",
        });
      }

      const TrainingModel = await PlanService.getTrainingModel(userId,agentId);
      const plan = await PlanService.getUserPlan(userId,agentId);

      const client = await Client.findOne({ userId });
      if (!client) {
        return res.status(404).json({
          success: false,
          error: "Client not found",
        });
      }
      const agent = await Agent.findOne({ _id: agentId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
        });
      }
      // if (client.sitemapAdded == true && sitemapUrl) {
      //   return res.status(400).json({
      //     success: false,
      //     error: "one sitemap already added",
      //   });
      // }
      const qdrantIndexName =
        client?.plan == "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;

      // Check if user is already scraping
      const scrapingStatus = await Agent.findOne({ _id: agentId });
      if (scrapingStatus.dataTrainingStatus == 1) {
        return res.status(409).json({
          success: false,
          error: "Scraping already in progress for this agent",
        });
      }
      //here updte the mongodb that scrapping started
      const scrapingStartTime = new Date();
      
      // Fetch and parse sitemap
      // let urls = [];
      // if (sitemapUrl) {
      //   urls = await this.extractUrlsFromSitemap(sitemapUrl);
      //   console.log(`Found ${urls.length} URLs in sitemap`);
      // }
      // if (url) {
      //   const batchService = new batchTrainingService();
      //   const urlArray = url.split(",").map((u) => u.trim());

      //   for (const singleUrl of urlArray) {
      //     // Check if the url already exists in the TrainingModel
      //     const existing = await TrainingModel.findOne({
      //       userId: userId,
      //       type: 0, // WebPage
      //       trainingStatus: 1,
      //       "webPage.url": singleUrl,
      //     });

      //     if (existing) {
      //       try {
      //         await batchService.deleteItemFromVectorStore(
      //           userId,
      //           singleUrl,
      //           0
      //         );
      //       } catch (error) {
      //         console.log(error);
      //       }
      //       await Url.deleteOne({ userId: userId, url: singleUrl });
      //       await TrainingModel.deleteOne({ _id: existing._id });
      //     }
      //   }
      //   urls.push(...urlArray);
      // }

      if (urls.length == 0) {
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", agentId, "training-event", {
          message: "No urls found",
          agent: await Agent.findOne({ _id: agentId }),
          client: await Client.findOne({ userId }),
        });
        return res.json({
          success: false,
          error: "No urls found",
        });
      }

      // Bulk insert URLs so the job can update them (job expects URLs in Url table)
      await this.bulkInsertUrls(userId, agentId, urls);

      // Set scraping status and start time before starting the queue
      await Agent.updateOne({ 
        _id: agentId 
      }, { 
        $set: { 
          dataTrainingStatus: 1,
          scrapingStartTime: scrapingStartTime
        } 
      });
      
      // if (sitemapUrl) {
      //   appEvents.emit("userEvent", userId, "training-event", {
      //     client: await Client.findOne({ userId }),
      //   });
      // }

      // Add the fetched URLs to the Url model
      // for (const url of urls) {
        // await Url.create({ userId: userId, url: url, trainStatus: 0 });
        // await this.bulkInsertUrls(userId, urls);
      // }

      await Agent.updateOne(
        { _id: agentId },
        { $set: { "pagesAdded.total": urls.length || 0 } }
      );

      await urlProcessingQueue.add("processSingleUrl", {
        urls,
        userId,
        qdrantIndexName,
        plan,
        agentId,
        startTime: scrapingStartTime.getTime(),
        totalUrls: urls.length,
      });


      res.json({
        success: true,
        // message: "Scraping sta successfully",
      });
    } catch (error) {
      const { userId, agentId } = req.body;
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", agentId, "training-event", {
        client: await Client.findOne({ userId }),
        message: error.message,
        agent: await Agent.findOne({ _id: agentId }),
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
      const { userId, agentId } = req.body;

      if (!userId || !agentId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: userId, agentId",
        });
      }

      const client = await Client.findOne({ userId });
      if (!client) {
        return res.status(404).json({
          success: false,
          error: "Client not found",
        });
      }
      const agent = await Agent.findOne({ _id: agentId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
        });
      }
      const qdrantIndexName =
        client?.plan == "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;
      const plan = await PlanService.getUserPlan(userId);

      const remainingUrls = await Url.distinct("url", {
        // userId: userId,
        agentId: agentId,
        trainStatus: 0,
      });
      if (remainingUrls.length <= 0) {
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: "No URL found to scrape",
        });
      } else {
        const scrapingStartTime = new Date();
        await Agent.updateOne({ 
          _id: agentId 
        }, { 
          $set: { 
            dataTrainingStatus: 1,
            scrapingStartTime: scrapingStartTime
          } 
        });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
        });

        await urlProcessingQueue.add("processSingleUrl", {
          urls: remainingUrls,
          userId,
          qdrantIndexName,
          plan,
          agentId: agentId,
          startTime: scrapingStartTime.getTime(),
          totalUrls: remainingUrls.length,
        });
      }

      res.json({
        success: true,
        // message: "Plan upgraded and scraping continued",
      });
    } catch (error) {
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
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

  async getScrapingHistoryBySocket(userId, agentId, skip, limit, type, status) {
    try {
      const TrainingModel = await PlanService.getTrainingModel(userId);

      const query = { userId, agentId };
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
      const { title, content, agentId,userId } = req.body;
      const file = req.file;
      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: agentId",
        });
      }
      const agent = await Agent.findOne({ _id: agentId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
        });
      }

      const client = await Client.findOne({ userId });
      if (!client) {
        return res
          .status(404)
          .json({ status: false, message: "Client not found" });
      }

      const qdrantIndexName =
        client?.plan == "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;

      const TrainingModel = await PlanService.getTrainingModel(userId);

      let documentsToProcess = [];
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 1 } });

      appEvents.emit("userEvent", userId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
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
          await Agent.updateOne(
            { _id: agentId },
            { $set: { dataTrainingStatus: 0 } }
          );
          appEvents.emit("userEvent", userId, "training-event", {
            agent: await Agent.findOne({ _id: agentId }),
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
          userId: userId,
          agentId: agentId,
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
            agent_id: agentId,
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
            await Agent.updateOne(
              { _id: agentId },
              { $set: { dataTrainingStatus: 0 } }
            );
            appEvents.emit("userEvent", userId, "training-event", {
              agent: await Agent.findOne({ _id: agentId }),
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
            agentId: agentId,
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
              agent_id: agentId,
              // plan: plan.name,
              // wordCount: fileValidation.wordCount,
              // estimatedTokens: fileValidation.estimatedTokens,
              // fileExtension: fileValidation.fileExtension,
            },
          });
        } catch (fileError) {
          await Agent.updateOne(
            { _id: agentId },
            { $set: { dataTrainingStatus: 0 } }
          );
          appEvents.emit("userEvent", userId, "training-event", {
            agent: await Agent.findOne({ _id: agentId }),
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
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
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
        agentId,
        qdrantIndexName,
        false
      );
      if (result.success) {
        await TrainingModel.findOneAndUpdate(
          { userId: userId, agentId: agentId, title: title || file.originalname },
          {
            trainingStatus: 1, // Completed
            chunkCount: result.totalChunks,
            lastEdit: Date.now(),
          }
        );
        await Agent.updateOne({ _id: agentId }, { $inc: { filesAdded: 1 } });

        // Update client flags
        await Agent.updateOne({ _id: agentId }, { dataTrainingStatus: 0 });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
        });
      } else {
        await TrainingModel.findByIdAndUpdate(
          { userId: userId, agentId: agentId, title: title || file.originalname },
          {
            trainingStatus: 2, // Error
            lastEdit: Date.now(),
            error: result.error,
          }
        );
        // Update client flags
        await Agent.updateOne({ _id: agentId }, { dataTrainingStatus: 0 });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: "Data training failed",
        });
      }

      res.status(201).json({
        status_code: 200,
        // message: "Documents validated and queued for processing successfully",
      });
    } catch (error) {
      const userId = req.body.userId;
      const agentId = req.body.agentId;
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
      appEvents.emit("userEvent", userId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
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

  // Updated createFaq with validation - now handles array of FAQs
  async createFaq(req, res) {
    const { faqs,userId,agentId } = req.body;

    try {
      const client = await Client.findOne({ userId });
      if (!client) {
        return res
          .status(404)
          .json({ status: false, message: "Client not found" });
      }
      const agent = await Agent.findOne({ _id: agentId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
        });
      }

      // Validate that faqs is an array
      if (!Array.isArray(faqs) || faqs.length === 0) {
        return res.status(400).json({
          status: false,
          message: "FAQs array is required and must not be empty",
          errorCode: "INVALID_INPUT",
        });
      }

      const qdrantIndexName =
        client?.plan == "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;

      const TrainingModel = await PlanService.getTrainingModel(userId);
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 1 } });

      appEvents.emit("userEvent", userId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      const documentsToProcess = [];
      const trainingEntries = [];
      const validationErrors = [];

      // Process each FAQ in the array
      for (let i = 0; i < faqs.length; i++) {
        const faq = faqs[i];
        const { question, answer } = faq;

        // Skip empty FAQs
        if (!question || !answer || !question.trim() || !answer.trim()) {
          validationErrors.push({
            index: i,
            id: faq.id,
            error: "Question and answer are required",
            errorCode: "MISSING_FIELDS",
          });
          continue;
        }

        // Validate FAQ content
        const faqValidation = await ContentValidationService.validateFAQ(
          question,
          answer,
          userId,
          agentId
        );

        if (!faqValidation.isValid) {
          validationErrors.push({
            index: i,
            id: faq.id,
            error: faqValidation.error,
            errorCode: faqValidation.errorCode,
            field: faqValidation.field,
          });
          continue;
        }

        // Create training model entry
        const trainingList = new TrainingModel({
          userId,
          agentId: agentId,
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
        trainingEntries.push({ model: trainingList, question });

        // Add to documents for batch processing
        documentsToProcess.push({
          type: 3,
          content: faqValidation.cleanContent,
          metadata: {
            title: question,
            question: question,
            answer: answer,
            type: "faq",
            user_id: userId,
            agent_id: agentId,
          },
        });
      }

      // If no valid FAQs after validation, return error
      if (documentsToProcess.length === 0) {
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });
        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: "No valid FAQs to process",
        });
        return res.status(400).json({
          status: false,
          message: "No valid FAQs to process",
          errorCode: "NO_VALID_FAQS",
          validationErrors: validationErrors,
        });
      }

      // Process all valid FAQs in batch
      const batchService = new batchTrainingService();
      let result = await batchService.processDocumentAndTrain(
        documentsToProcess,
        userId,
        agentId,
        qdrantIndexName,
        false
      );

      if (result.success) {
        // Update all successfully processed FAQs
        const totalChunks = result.totalChunks || 0;
        const chunksPerFaq = Math.floor(totalChunks / trainingEntries.length);

        for (let i = 0; i < trainingEntries.length; i++) {
          const { model, question } = trainingEntries[i];
          // Distribute chunks evenly, last entry gets remainder
          const chunkCount = i === trainingEntries.length - 1 
            ? totalChunks - (chunksPerFaq * (trainingEntries.length - 1))
            : chunksPerFaq;

          await TrainingModel.findOneAndUpdate(
            { _id: model._id },
            {
              trainingStatus: 1, // Completed
              chunkCount: chunkCount,
              lastEdit: Date.now(),
            }
          );
        }

        await Agent.updateOne(
          { _id: agentId },
          { 
            $inc: { faqsAdded: documentsToProcess.length },
            $set: { dataTrainingStatus: 0 }
          }
        );

        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
        });

        res.status(201).json({
          status_code: 200,
          message: `${documentsToProcess.length} FAQ(s) validated and processed successfully`,
          processed: documentsToProcess.length,
          failed: validationErrors.length,
          validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        });
      } else {
        // Mark all as failed
        for (const { model } of trainingEntries) {
          await TrainingModel.findByIdAndUpdate(
            model._id,
            {
              trainingStatus: 2, // Error
              lastEdit: Date.now(),
              error: result?.error,
            }
          );
        }

        // Update client flags
        await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });

        appEvents.emit("userEvent", userId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: "failed to train data",
        });

        res.status(500).json({
          status: false,
          message: "Failed to process FAQs",
          errorCode: "TRAINING_FAILED",
          error: result?.error,
        });
      }
    } catch (error) {
      await Agent.updateOne({ _id: agentId }, { $set: { dataTrainingStatus: 0 } });

      appEvents.emit("userEvent", userId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
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

  /**
   * Delete training data by IDs. Runs in background.
   * Body: { ids: string[], agentId: string }
   */
  async deleteTrainingData(req, res) {
    try {
      const { ids, agentId, userId } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: "ids array is required and must not be empty",
        });
      }

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: "agentId is required",
        });
      }

      // Verify agent belongs to user
      const agent = await Agent.findOne({ _id: agentId, userId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
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
        client?.plan === "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;

      if (!qdrantIndexName) {
        return res.status(400).json({
          success: false,
          error: "Agent has no Qdrant collection configured",
        });
      }

      const TrainingModel = await PlanService.getTrainingModel(userId);
      const plan = await PlanService.getUserPlan(userId);
      const TrainingModelName =
        plan?.name === "free" ? "TrainingListFreeUsers" : "OpenaiTrainingList";

      // Fetch entries by _ids, ensure they belong to this user and agent
      const mongoose = require("mongoose");
      const objectIds = ids
        .filter((id) => id)
        .map((id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id));
      const entries = await TrainingModel.find({
        _id: { $in: objectIds },
        userId: userId?.toString(),
        agentId,
      }).lean();

      if (entries.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No matching training entries found",
        });
      }

      // Add job to background queue
      await deleteTrainingDataQueue.add("deleteTrainingData", {
        entries,
        userId: userId?.toString(),
        agentId: agentId?.toString(),
        qdrantIndexName,
        TrainingModelName,
      });

      res.status(200).json({
        success: true,
        message: "Delete job queued. Training data will be removed in the background.",
        count: entries.length,
      });
    } catch (error) {
      console.error("deleteTrainingData error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to delete training data",
      });
    }
  }

  /**
   * Retrain training data by IDs. Only webpages (type 0) are retrained. Runs in background.
   * Body: { ids: string[], agentId: string }
   */
  async retrainTrainingData(req, res) {
    try {
      const { ids, agentId, userId } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: "ids array is required and must not be empty",
        });
      }

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: "agentId is required",
        });
      }

      const agent = await Agent.findOne({ _id: agentId, userId });
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: "Agent not found",
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
        client?.plan === "free"
          ? agent?.qdrantIndexName
          : agent?.qdrantIndexNamePaid;

      if (!qdrantIndexName) {
        return res.status(400).json({
          success: false,
          error: "Agent has no Qdrant collection configured",
        });
      }

      const TrainingModel = await PlanService.getTrainingModel(userId);
      const plan = await PlanService.getUserPlan(userId);
      const TrainingModelName =
        plan?.name === "free" ? "TrainingListFreeUsers" : "OpenaiTrainingList";

      const mongoose = require("mongoose");
      const objectIds = ids
        .filter((id) => id)
        .map((id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id));
      const entries = await TrainingModel.find({
        _id: { $in: objectIds },
        userId: userId?.toString(),
        agentId,
      }).lean();

      if (entries.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No matching training entries found",
        });
      }

      // Filter to only webpages (type 0) - others are skipped in the job
      const webpageEntries = entries.filter((e) => e.type === 0 && e.webPage?.url);
      if (webpageEntries.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No webpage entries found to retrain. Only web pages (type 0) can be retrained.",
        });
      }

      await retrainTrainingDataQueue.add("retrainTrainingData", {
        entries: webpageEntries,
        userId: userId?.toString(),
        agentId: agentId?.toString(),
        qdrantIndexName,
        TrainingModelName,
      });

      res.status(200).json({
        success: true,
        message: "Retrain job queued. Web pages will be scraped and retrained in the background.",
        count: webpageEntries.length,
      });
    } catch (error) {
      console.error("retrainTrainingData error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to retrain training data",
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
