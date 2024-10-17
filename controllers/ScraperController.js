const axios = require("axios");
const cheerio = require("cheerio");
const tfjs = require('@tensorflow/tfjs');
const use = require('@tensorflow-models/universal-sentence-encoder');
const Client = require("../models/Client");
const Sitemap = require("../models/Sitemap");
const TrainingList = require("../models/TrainingList");
// const WebPage = require("../models/WebPage");
// const WebPageSource = require("../models/WebPageSource");
// const Faq = require("../models/Faq");
// const Snippet = require("../models/Snippet");
// const mongoose = require("mongoose");
const ObjectId = require("mongoose").Types.ObjectId;
const ScraperController = {};

const clientStatus = {};

async function insertOrUpdateSitemapRecords(urls, userId, sitemapId) {
  const insertedRecords = [];
  const updatedRecords = [];
  const duplicateRecords = [];

  const existingRecords = await Sitemap.find({ url: { $in: urls }, userId });

  for (const url of urls) {
    const existingRecord = existingRecords.find(record => record.url === url);

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
  await Promise.all(existingRecords.map(record => record.save()));
  return { insertedRecords, updatedRecords, duplicateRecords };
}

async function createTrainingListAndWebPages(urls, userId, sitemapId) {
  // const session = await mongoose.startSession();
  // session.startTransaction();

  try {
    // Step 1: Insert into TrainingList
    const trainingListDocuments = urls.map((url) => ({
      userId: userId,
      title: url,
      type: 0,

      webPage: {
        url,
        sitemapIds: [sitemapId],
      }
    }));

    const trainingListResult = await TrainingList.insertMany(trainingListDocuments); //, { session }

    // Step 2: Insert into WebPage
    // const webPageDocuments = trainingListResult.map((trainingList) => ({
    //   trainingListId: trainingList._id,
    //   url: trainingList.title,
    //   sitemapIds: [sitemapId],
    // }));

    // await WebPage.insertMany(webPageDocuments); //, { session }

    // await session.commitTransaction();
    // session.endSession();

    // console.log("Data inserted successfully");
  } catch (error) {
    // await session.abortTransaction();
    // session.endSession();
    console.error("Error inserting data:", error);
  }
}

async function webPageMapping(client, userId, req) {
  try {
    if(clientStatus[userId] && clientStatus[userId].webPageMapping) {
      // setTimeout
      return;
    }
    clientStatus[userId] = { webPageMapping: true };
    // if(client.webPageMappingCount > 0) {
    const model = await use.load();
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        'webPage.minifyingStatus': 2,
        trainingStatus: 3
        // $or: [
        //   { 'mapping': { $exists: false } },
        //   { 'mapping.mappingStatus': { $nin: [2, 3] } }
        // ]
      }).limit(10);
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
        // console.log("For Mapping",trainingListObj);      
      // while(trainingListObj && trainingListObj.webPage.sourceCode) {
        try {
          trainingListObj.mapping.mappingStatus = 1;
          trainingListObj.mapping.mappingDuration.start = Date.now();
          await trainingListObj.save();
          const parts = trainingListObj.webPage.parts;
          for(const part of parts) {
            const embedding = await model.embed(part.content);
            // const embeddingValues = Array.from(embedding.dataSync());
            const embeddingValues = embedding.arraySync()[0];
              // console.log("embedding", embedding, "embeddingValues", embeddingValues);
              // console.log(modifiedHtml);
              // res.send('This is just for testing <br> '+modifiedHtml);

            part.embedding = embedding;
            part.embeddingValues = embeddingValues
          }
          
            // trainingListObj.mapping.mappingLocation = {
            //   type: "Point",
            //   coordinates: embeddingValues
            // };

          trainingListObj.webPage.parts = parts;
          trainingListObj.mapping.mappingStatus = 2;
          trainingListObj.mapping.mappingDuration.end = Date.now();
          trainingListObj.trainingStatus = 4;
          await trainingListObj.save();
        }
        catch(error) {
          console.log("Error in mapping "+trainingListObj.webPage.url);
          // trainingListObj.trainingStatus = 3;
          trainingListObj.webPage.minifyingStatus = 3;
          trainingListObj.trainingStatus = 9;
          trainingListObj.lastEdit = Date.now();
          await trainingListObj.save();
          // await TrainingList.findByIdAndUpdate(trainingListObj._id, { trainingStatus: 2, lastEdit: Date.now() });
          console.log(error);
        }
        // trainingListObj = await TrainingList.findOne({
        //   userId,
        //   type: 0,
        //   'webPage.crawlingStatus': 2,
        //   $or: [
        //     { 'mapping': { $exists: false } },
        //     { 'mapping.mappingStatus': { $nin: [2, 3] } }
        //   ]
        // });
        // client.webPageMappingCount = (client.webPageMappingCount-1);
        // await client.save();
      // } // End loop
      }));
      // console.log("mapped");
      if(trainingListObjArray.length) {
        // const updatedMappedCount = await TrainingList.countDocuments({
        //   userId: new ObjectId(userId),
        //   type: 0,
        //   'mapping.mappingStatus': 2
        // }).exec();
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-mapped',{
          // updatedMappedCount,
          list
        });
      }
    } while (trainingListObjArray.length > 0); 
    // }
    clientStatus[userId] = { webPageMapping: false };
    console.log("Complete Done");
  }
  catch (error) {
    console.error("Error in webpage mapping", error);
    clientStatus[userId] = { webPageMapping: false };
  }
}

async function webPageMinifying(client, userId, req) {
  try {
    if(clientStatus[userId] && clientStatus[userId].webPageMinifying) {
      // setTimeout
      return;
    }
    clientStatus[userId] = { webPageMinifying: true };
    // if(client.webPageMappingCount > 0) {
      const model = await use.load();
      const allowedTags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd","a" ];
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        'webPage.crawlingStatus': 2,
        trainingStatus: 2
        // $or: [
        //   { 'mapping': { $exists: false } },
        //   { 'mapping.mappingStatus': { $nin: [2, 3] } }
        // ]
      }).limit(10);
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
        // console.log("For Mapping",trainingListObj);      
      // while(trainingListObj && trainingListObj.webPage.sourceCode) {
        try {
          trainingListObj.webPage.minifyingStatus = 1;
          trainingListObj.webPage.minifyingDuration.start = Date.now();
          await trainingListObj.save();
          
          const $ = cheerio.load(trainingListObj.webPage.sourceCode);
          // const $ = cheerio.load(html);
          // Handle singular tags appropriately
          const title = $("title").text();
          const metaDescription = $('meta[name="description"]').attr('content');
          $("br, hr").remove(); // or replace with a suitable representation
          // Remove style, script tags
          $("style, script").remove();
          // Remove comments
          $("*")
            .contents()
            .filter(function () {
              return this.nodeType === 8;
            })
            .remove();
          // Handle other singular tags appropriately
          $("img, input").remove(); // or handle differently based on your requirements
          
          // Replace all tags other than allowed tags with their inner HTML recursively
          function replaceNonAllowedTags(element) {
            $(element)
              .contents()
              .each(function () {
                if (this.nodeType === 1) {
                  replaceNonAllowedTags(this);
                  // Check if the current node is not in the allowed tag list
                  if (!allowedTags.includes(this.name)) {
                    // Check if there is exactly 1 immediate child node of type 1
                    const childNodes = $(this)
                      .children()
                      .filter(function () {
                        return this.nodeType === 1;
                      });

                    if (childNodes.length === 1) {
                      // Replace the outer node with its inner HTML
                      const innerHtml = $(this).html() || "";
                      $(this).replaceWith(innerHtml);
                    }
                  }
                }
              });
          }
          replaceNonAllowedTags("body");

          // Remove empty elements recursively
          function removeEmptyElements(element) {
            $(element)
              .contents()
              .each(function () {
                if (this.nodeType === 1) {
                  removeEmptyElements(this);
                  // if ($(this).is(":empty")) {
                  if ($(this).is(":empty") || /^\s*$/.test($(this).text())) {
                    $(this).remove();
                  }
                }
              });
          }
          removeEmptyElements("body");
          // Remove trailing spaces
          // $('*').each(function () {
          //     if ($(this).is('p, h1, h2, h3, h4, h5, h6, li')) {
          //         // $(this).text($.trim($(this).text()));
          //         // $(this).text($(this).text().trim());
          //         $(this).html($(this).html().replace(/(<a [^>]+>[^<]+<\/a>)/g, ' $1 ')); // Preserve links
          //         $(this).text($(this).text().trim());
          //     }
          // });
          $("*").each(function () {
            if ($(this).is("p, h1, h2, h3, h4, h5, h6, li")) {
              // Preserve anchor tags while trimming text
              $(this)
                .contents()
                .filter(function () {
                  return this.nodeType === 3; // Filter for text nodes
                })
                .each(function () {
                  this.nodeValue = this.nodeValue.trim(); // Trim text content
                });
            }
          });

          
          // Remove unused attributes
          // $('*').removeAttr('style');
          $("*").each(function () {
            const allowedAttributes = ["src", "href"];

            // Get all attributes of the current element
            const attributes = this.attribs;

            // Check each attribute
            for (const attr in attributes) {
              if (attributes[attr] && !allowedAttributes.includes(attr)) {
                // Remove the non-allowed attributes
                delete attributes[attr];
              }
            }
          });
          
          // removeEmptyElements("body");

          // Get the modified HTML
          const content = $("body").html().replace(/\s+/g, " ").trim();

          trainingListObj.webPage.content = content;

          function splitContent(content, maxLength) {
            const parts = [];
            let start = 0;        
            while (start < content.length) {
                const part = content.substr(start, maxLength);
                parts.push({ content: part });
                start += maxLength;
            }        
            return parts;
          }

          const maxLength = 1200;
          const parts = splitContent(content, maxLength);
          // console.log(parts);


          trainingListObj.webPage.parts = parts; //[{content}];
          trainingListObj.webPage.title = title;
          trainingListObj.webPage.metaDescription = metaDescription;
          trainingListObj.lastEdit = Date.now();
          trainingListObj.webPage.minifyingStatus = 2;
          trainingListObj.webPage.minifyingDuration.end = Date.now();
          trainingListObj.trainingStatus = 3;
          // trainingListObj.mapping.mappingStatus = 1;
          // trainingListObj.mapping.mappingDuration.start = Date.now();
          await trainingListObj.save();
            // webPageMapping(client, userId, req);
          // const embedding = await model.embed(content);
            // const embeddingValues = Array.from(embedding.dataSync());
          // const embeddingValues = embedding.arraySync()[0];
            // console.log("embedding", embedding, "embeddingValues", embeddingValues);
            // console.log(modifiedHtml);
            // res.send('This is just for testing <br> '+modifiedHtml);

          // trainingListObj.mapping.embedding = embedding;
          // trainingListObj.mapping.embeddingValues = embeddingValues;
            // trainingListObj.mapping.mappingLocation = {
            //   type: "Point",
            //   coordinates: embeddingValues
            // };
          // trainingListObj.mapping.mappingStatus = 2;
          // trainingListObj.mapping.mappingDuration.end = Date.now();
          // trainingListObj.trainingStatus = 4;
          // await trainingListObj.save();
        }
        catch(error) {
          console.log("Error in minifying "+trainingListObj.webPage.url);
          // trainingListObj.trainingStatus = 3;
          trainingListObj.webPage.minifyingStatus = 3;
          trainingListObj.trainingStatus = 9;
          trainingListObj.lastEdit = Date.now();
          await trainingListObj.save();
          // await TrainingList.findByIdAndUpdate(trainingListObj._id, { trainingStatus: 2, lastEdit: Date.now() });
          console.log(error);
        }
        // trainingListObj = await TrainingList.findOne({
        //   userId,
        //   type: 0,
        //   'webPage.crawlingStatus': 2,
        //   $or: [
        //     { 'mapping': { $exists: false } },
        //     { 'mapping.mappingStatus': { $nin: [2, 3] } }
        //   ]
        // });
        // client.webPageMappingCount = (client.webPageMappingCount-1);
        // await client.save();
      // } // End loop
      }));
      // console.log("mapped");
      if(trainingListObjArray.length) {
        // const updatedMappedCount = await TrainingList.countDocuments({
        //   userId: new ObjectId(userId),
        //   type: 0,
        //   'webPage.minifyingStatus': 2
        // }).exec();
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-minified',{
          // updatedMappedCount,
          list
        });
        webPageMapping(client, userId, req);
      }
    } while (trainingListObjArray.length > 0); 
    // }
    clientStatus[userId] = { webPageMinifying: false };
    // console.log("Complete Done");
  }
  catch (error) {
    console.error("Error in webpage mapping", error);
    clientStatus[userId] = { webPageMinifying: false };
  }
}
async function webPageCrawling(client, userId, req) {
  try {
    if(clientStatus[userId] && clientStatus[userId].webPageScrapping) {
      // setTimeout
      return;
    }
    clientStatus[userId] = { webPageScrapping: true };
    // if(client.webPageScrappingStatus == 0) {
    //   client.webPageScrappingStatus = 1;
    //   await client.save();
      // await Sitemap.findByIdAndUpdate(sitemapObj._id, { status: 1 });
      // let trainingListObj = await TrainingList.findOne({ userId, type:0, trainingStatus: 0 });
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        trainingStatus: 1,
        // $or: [
        //   { 'webPage': { $exists: false } },
        //   { 'webPage.crawlingStatus': { $nin: [2, 3] } }
        // ]
      }).limit(10);
      
      /*
      let [trainingListObj] = await TrainingList.aggregate([
        {
          $match: { 
            userId: new ObjectId(userId), 
            type:0, trainingStatus: 0 }
        },
        {
          $limit: 1
        },
        {
          $lookup: {
            from: 'webpages',
            localField: '_id',
            foreignField: 'trainingListId',
            as: 'webPages'
          }
        },
        {
          $addFields: {
            webPage: {
              $arrayElemAt: ['$webPages', 0]
            }
          }
        },
        {
          $project: {
            webPages: 0
          }
        }
        
      ]);
      */
      // console.log('trainingListObj',trainingListObj);
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
      
        // console.log("For Crawling",trainingListObj);
      // while(trainingListObj) {
        // trainingListObj.trainingStatus = 1;
        trainingListObj.webPage.crawlingStatus = 1;
        trainingListObj.webPage.crawlingDuration.start = Date.now();
        await trainingListObj.save();
        const url = trainingListObj.webPage.url;
        
        try {
          // console.log("url", url);
          let config = {
            method: 'get',
            maxBodyLength: Infinity,
            url: url,
            headers: { }
          };
          const response = await axios.request(config);
          // await WebPageSource.create({webPageId: trainingListObj.webPage._id, sourceCode: response.data});
          trainingListObj.webPage.sourceCode = response.data;
          trainingListObj.webPage.crawlingStatus = 2;
          trainingListObj.webPage.crawlingDuration.end = Date.now();
          trainingListObj.trainingStatus = 2;
          await trainingListObj.save();
          // client.webPageMappingCount = client.webPageMappingCount?(client.webPageMappingCount+1):1;
          // await client.save();
          webPageMinifying(client, userId, req);

          // Update urlObj.content and urlObj.status accordingly
          
          // await WebPage.findByIdAndUpdate(trainingListObj.webPage._id, { content, title, metaDescription });
          // await TrainingList.findByIdAndUpdate(trainingListObj._id, { trainingStatus: 1, lastEdit: Date.now(), embedding, embeddingValues });
          // trainingListObj.trainingStatus = 2;
          
        }
        catch(error) {
          console.log("Error in scrapping "+url);
          // trainingListObj.trainingStatus = 3;
          trainingListObj.webPage.crawlingStatus = 3;
          trainingListObj.trainingStatus = 9;
          // trainingListObj.webPage.crawlingDuration.end = Date.now();
          trainingListObj.lastEdit = Date.now();
          await trainingListObj.save();
          // await TrainingList.findByIdAndUpdate(trainingListObj._id, { trainingStatus: 2, lastEdit: Date.now() });
          console.log(error);
        }

        /*
        const nextTrainingList = await TrainingList.aggregate([
          {
            $match: { 
              userId: new ObjectId(userId), 
              type:0, trainingStatus: 0 }
          },
          {
            $limit: 1
          },
          {
            $lookup: {
              from: 'webpages',
              localField: '_id',
              foreignField: 'trainingListId',
              as: 'webPages'
            }
          },
          {
            $addFields: {
              webPage: {
                $arrayElemAt: ['$webPages', 0]
              }
            }
          },
          {
            $project: {
              webPages: 0
            }
          }       
        ]);
        trainingListObj = nextTrainingList[0];
        */

        // trainingListObj = await TrainingList.findOne({
        //   userId,
        //   type: 0,
        //   // trainingStatus: 0,
        //   $or: [
        //     { 'webPage': { $exists: false } },
        //     { 'webPage.crawlingStatus': { $nin: [2, 3] } }
        //   ]
        // });
      // } // Loop end
      }));
      if(trainingListObjArray.length) {
        const updatedCrawledCount = await TrainingList.countDocuments({
          userId: new ObjectId(userId),
          type: 0,
          'webPage.crawlingStatus': 2
        }).exec();
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-crawled',{
          updatedCrawledCount,
          list
        });
      }
    } while (trainingListObjArray.length > 0); // Loop end
    clientStatus[userId] = { webPageScrapping: false };
    //   client.webPageScrappingStatus = 0;
    //   await client.save();
    // }
  }
  catch(error) {
    console.error("Error in webpage scrapping", error);
    clientStatus[userId] = { webPageScrapping: false };
  }
}

ScraperController.scrape = async (req, res) => {
  const { sitemap } = req.body;
  const userId = req.body.userId;
  try {
    const client = await Client.findOne({userId});
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
        //const scrapeSitemap = async (sitemapObj) => {
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
              .get(); 
            // const insertedWebPages = await insertOrUpdateWebPageRecords(webPageLocs, userId, sitemapObj._id);
            // insertOrUpdateWebPageRecords(webPageLocs, userId, sitemapObj._id)
            //   .then((insertedWebPages) => {
              // })
              // .catch(error => console.error('Error:', error));  
            if(webPageLocs.length) {
              await createTrainingListAndWebPages(webPageLocs, userId, sitemapObj._id);
              req.io.to('user'+userId).emit('web-pages-added');
              webPageCrawling(client, userId, req);
            }

            // const delayInMilliseconds = 1000;
            const sitemapLocs = $("sitemap loc")
              .map((index, element) => $(element).text())
              .get();
            if(sitemapLocs.length) {
              const insertedSitemaps = await insertOrUpdateSitemapRecords(sitemapLocs, userId, sitemapObj._id);
            }
            // insertOrUpdateSitemapRecords(sitemapLocs, userId, sitemapObj._id)
            //   .then(async (insertedSitemaps) => {
                // insertedSitemaps.insertedRecords.map(async (sitemapObj) => {

                // for (const sitemapObj of insertedSitemaps.insertedRecords) {
                //   await scrapeSitemap(sitemapObj);
                //   await Sitemap.findByIdAndUpdate(sitemapObj._id, { status: 1 });
                //   await new Promise(resolve => setTimeout(resolve, delayInMilliseconds));
                // }

              // })
              // .catch(error => console.error('Error:', error));        
            

            // await Promise.all(urlPromises);
            // await sitemapObj.save();

            // Emit socket event: Scraping completed for this sitemap
          }
          catch(error) {
            console.log("Error in scrapping "+sitemapObj.url);
            console.log(error);
          }
          sitemapObj.status = 1;
          await sitemapObj.save();
          // await Sitemap.findByIdAndUpdate(sitemapObj._id, { status: 1 });
          sitemapObj = await Sitemap.findOne({ userId, status: 0 });
        } // Loop end

        // Start scraping from the main sitemap
        // await scrapeSitemap(sitemapObj);

        // Update Sitemap status
        // await Sitemap.findByIdAndUpdate(sitemapObj._id, { status: 1 });
        // req.io.to('user'+userId).emit('web-page-added');
        // console.log("Done sitemap scrapping");
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
          crawledPagesCount: { $sum: { $cond: { if: { $eq: ['$webPage.crawlingStatus', 2] }, then: 1, else: 0 } } },
          mappedPagesCount: { $sum: { $cond: { if: { $eq: ['$mapping.mappingStatus', 2] }, then: 1, else: 0 } } }
        }
      }
    ]).exec();
    
    const counts = result.length > 0 ? result[0] : { totalUrlCount: 0, crawledPagesCount: 0, mappedPagesCount: 0 };
    // console.log(result, counts);
    return {
      totalPages: counts.totalUrlCount,
      crawledPages: counts.crawledPagesCount,
      mappedPages: counts.mappedPagesCount
    };
    
  } catch (error) {
    console.log("Error in getWebPageUrlCount.");
    // return res
    //   .status(500)
    //   .json({ status_code: 500, status: false, message: "Please try again!" });
  }
};

ScraperController.getWebPageList = async (userId) => {
  try {
    const webPages = await TrainingList.aggregate([
      {
        $match: {
          userId: new ObjectId(userId),
        },
      },
      {
        $project: {
          title: 1,
          type: 1,
          lastEdit: {
            $dateToString: {
              format: "%B %d, %Y",
              date: "$lastEdit",
              timezone: "UTC", // Adjust the timezone if needed
            },
          },
          timeUsed: 1,
          crawlingStatus: "$webPage.crawlingStatus",
          minifyingStatus: "$webPage.minifyingStatus",
          mappingStatus: "$mapping.mappingStatus",
          isActive: 1,

          crawlingDuration: "$webPage.crawlingDuration",
          minifyingDuration: "$webPage.minifyingDuration",
          mappingDuration: "$mapping.mappingDuration",

          trainingStatus: 1,
        },
      },
      // {
      //   $limit: 10, // Limit the result to 10 documents
      // },
    ]);
    return webPages;
  } catch (error) {
    console.log(error);
    throw new Error("Please try again!");
  }
};

module.exports = ScraperController;
