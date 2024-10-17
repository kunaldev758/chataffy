/* OpenAI */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const officeParser = require('officeparser');

const axios = require("axios");
const cheerio = require("cheerio");
const Client = require("../models/Client");
const Sitemap = require("../models/OpenaiSitemap");
const TrainingList = require("../models/OpenaiTrainingList");
const OpenAIController = require("./OpenAIController");
const urlModule = require('url');

// const WebPage = require("../models/WebPage");
// const WebPageSource = require("../models/WebPageSource");
// const Faq = require("../models/Faq");
// const Snippet = require("../models/Snippet");
// const mongoose = require("mongoose");
const commonHelper = require("../helpers/commonHelper.js");
const ObjectId = require("mongoose").Types.ObjectId;
const ScraperController = {};

const clientStatus = {};

const readFileContent = (filePath, mimeType) => {
  return new Promise((resolve, reject) => {
    if (mimeType === 'text/plain') {
      // Read .txt file
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    } else if (mimeType === 'application/pdf') {
      // Read .pdf file
      fs.readFile(filePath, (err, data) => {
        if (err) reject(err);
        pdfParse(data).then((data) => resolve(data.text)).catch(reject);
      });
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Read .docx file
      mammoth.extractRawText({ path: filePath })
        .then(result => resolve(result.value))
        .catch(reject);
    } else if (mimeType === 'application/msword') {
      // Read .doc file
      officeParser.parseOfficeAsync(filePath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    } else {
      resolve('');
    }
  });
};

ScraperController.getTrainingListDetail = async (req, res) => {
  try {
    const userId = req.body.userId;
    const {id} = req.body;
    const trainingList = await TrainingList.findById(id);
    if(!trainingList) {
      res.status(200).json({ status: false, message: "No matching record found" });    
      return;  
    }
    if(trainingList.userId != userId) {
      res.status(200).json({ status: false, message: "Not authorised for this training" });    
      return;  
    }
    res.status(200).json(trainingList);      
  } 
  catch (error) {
     commonHelper.logErrorToFile(error);
    res.status(500).json({ status: false, message: "Something went wrong please try again!" });
  }
};




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
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        // 'webPage.minifyingStatus': 2,
        trainingStatus: 3
        // $or: [
        //   { 'mapping': { $exists: false } },
        //   { 'mapping.mappingStatus': { $nin: [2, 3] } }
        // ]
      }).limit(10);
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
        try {
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'trainingProcessStatus.mappingStatus': 1, 
            'trainingProcessStatus.mappingDuration.start': Date.now()
          });
          const mappings = trainingListObj.mappings;
          const input = mappings.map(({content})=>content);
          // console.log("input", input);
          const embeddingData = await OpenAIController.createEmbedding(input);
          // console.log("embeddingData", embeddingData);
          embeddingData.map((data)=>{
            mappings[data.index]['embeddingValues'] = data.embedding;
          });
          
            // trainingListObj.mapping.mappingLocation = {
            //   type: "Point",
            //   coordinates: embeddingValues
            // };
          
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'mappings': mappings,  
            'trainingProcessStatus.mappingStatus': 2,  
            'trainingProcessStatus.mappingDuration.end': Date.now(),  
            'trainingStatus': 4
          });
          trainingListObj.trainingStatus = 4;
        }
        catch(error) {
          console.log("Error in mapping "+trainingListObj.webPage.url);
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'trainingProcessStatus.mappingStatus': 3,
            'lastEdit': Date.now(),
            'trainingStatus': 9
          });
          trainingListObj.trainingStatus = 9;
          console.log(error);
        }
      }));
      if(trainingListObjArray.length) {
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-mapped',{
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
      // const model = await use.load();
    const allowedTags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd","a" ];
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        // 'webPage.crawlingStatus': 2,
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
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'trainingProcessStatus.minifyingStatus': 1, 
            'trainingProcessStatus.minifyingDuration.start': Date.now()
          });
          const sourceCode = trainingListObj.webPage.sourceCode;
          const $ = cheerio.load(sourceCode);
          const webPageURL = trainingListObj.webPage.url;
          
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

          // Function to convert relative URLs to absolute
          function convertToAbsoluteUrl(relativeUrl, baseUrl) {
            return urlModule.resolve(baseUrl, relativeUrl);
          }

          // Update relative URLs to absolute URLs
          $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('http') && href!=='#') { // !href.startsWith('#')
                $(el).attr('href', convertToAbsoluteUrl(href, webPageURL));
            }
          });

          // Replace iframes with a message or remove them if no src attribute
          $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src) {
                $(el).replaceWith(`${convertToAbsoluteUrl(src, webPageURL)}`);
            } else {
                $(el).remove();
            }
          });

          // Replace form elements with a message
          $('form').each((i, el) => {
              $(el).prepend(`Form on URL: ${webPageURL}`);
          });
          
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
          const minifiedContent = content;
          // trainingListObj.webPage.content = content;

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
          const mappings = [{ content: `<div>URL: ${webPageURL} <br/>Title: ${title} <br/>Meta Description: ${metaDescription} <br/></div>`},...splitContent(content, maxLength)];
          // console.log(mappings);

          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'webPage.title': title,  
            'webPage.metaDescription': metaDescription, 
            'webPage.content': minifiedContent, 
            'mappings': mappings,  
            'lastEdit': Date.now(),  
            'trainingProcessStatus.minifyingStatus': 2,  
            'trainingProcessStatus.minifyingDuration.end': Date.now(),  
            'trainingStatus': 3
          });
          trainingListObj.trainingStatus = 3;
        }
        catch(error) {
          console.log("Error in minifying "+trainingListObj.webPage.url);
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'lastEdit': Date.now(),  
            'trainingProcessStatus.minifyingStatus': 3,
            'trainingStatus': 9
          });
          trainingListObj.trainingStatus = 9;
          console.log(error);
        }
      }));
      if(trainingListObjArray.length) {
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-minified',{
          list
        });

        webPageMapping(client, userId, req);
      }
    } while (trainingListObjArray.length > 0); 
    // }
    clientStatus[userId] = { webPageMinifying: false };
  }
  catch (error) {
    console.error("Error in webpage mapping", error);
    clientStatus[userId] = { webPageMinifying: false };
  }
}

async function webPageCrawling(client, userId, req) {
  try {
    if(clientStatus[userId] && clientStatus[userId].webPageCrawling) {
      // setTimeout
      return;
    }
    clientStatus[userId] = { webPageCrawling: true };
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
      
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {        
        await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
          'trainingProcessStatus.crawlingStatus': 1, 
          'trainingProcessStatus.crawlingDuration.start': Date.now()
        });
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
          
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'webPage.sourceCode': response.data,
            'trainingProcessStatus.crawlingStatus': 2,
            'trainingProcessStatus.crawlingDuration.end': Date.now(), 
            'trainingStatus': 2, 
          });
          trainingListObj.trainingStatus = 2;
        }
        catch(error) {
          console.log("Error in scrapping "+url);
          await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
            'trainingProcessStatus.crawlingStatus': 3,
            'lastEdit': Date.now(), 
            'trainingStatus': 9,  // Error
          });
          trainingListObj.trainingStatus = 9;
          console.log(error);
        }
      }));
      
      if(trainingListObjArray.length) {
        const updatedCrawledCount = await TrainingList.countDocuments({
          userId: new ObjectId(userId),
          type: 0,
          'trainingProcessStatus.crawlingStatus': 2
        }).exec();
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user'+userId).emit('web-pages-crawled',{
          updatedCrawledCount,
          list
        });

        webPageMinifying(client, userId, req);
      }
    } while (trainingListObjArray.length > 0); // Loop end
    clientStatus[userId] = { webPageCrawling: false };
  }
  catch(error) {
    console.error("Error in webpage scrapping", error);
    clientStatus[userId] = { webPageCrawling: false };
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
          crawledPagesCount: { $sum: { $cond: { if: { $eq: ['$trainingProcessStatus.crawlingStatus', 2] }, then: 1, else: 0 } } },
          mappedPagesCount: { $sum: { $cond: { if: { $eq: ['$trainingProcessStatus.mappingStatus', 2] }, then: 1, else: 0 } } }
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

// Counting snippets and files both
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
          crawledDocs: { $sum: { $cond: { if: { $eq: ['$trainingStatus', 4] }, then: 1, else: 0 } } }
        }
      }
    ]).exec();
    
    const counts = result.length > 0 ? result[0] : {crawledDocs: 0, totalDocs: 0};
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
          crawledFaqs: { $sum: { $cond: { if: { $eq: ['$trainingStatus', 4] }, then: 1, else: 0 } } }
        }
      }
    ]).exec();
    
    const counts = result.length > 0 ? result[0] : {crawledFaqs: 0, totalFaqs: 0};
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
          crawlingStatus: "$trainingProcessStatus.crawlingStatus",
          minifyingStatus: "$trainingProcessStatus.minifyingStatus",
          mappingStatus: "$trainingProcessStatus.mappingStatus",
          isActive: 1,

          crawlingDuration: "$trainingProcessStatus.crawlingDuration",
          minifyingDuration: "$trainingProcessStatus.minifyingDuration",
          mappingDuration: "$trainingProcessStatus.mappingDuration",

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


// ScraperController.createSnippet = async (req, res) => {
//   const { title, content } = req.body;
//   const userId = req.body.userId;
//   try {
//     // const client = await Client.findOne({userId});
//     const trainingList = new TrainingList({
//       userId,
//       title,
//       type: 2,
//       snippet: {
//         title,
//         content
//       }
//     });
//     await trainingList.save();
//     res.status(201).json({ status_code: 200, message: "Snippet added." });

//     try {     
//       const input =[]; 
//       async function splitContentAndMapping(content, maxLength) {
//         const parts = [];
//         let start = 0;  
//         while (start < content.length) {
//             const part = content.substr(start, maxLength);
//             parts.push({ content: part });
//             input.push(part);
//             start += maxLength;
//         }        
//         return parts;
//       }

//       const maxLength = 1200;
//       const mappings = await splitContentAndMapping(content, maxLength);
//       const embeddingData = await OpenAIController.createEmbedding(input);
//       // console.log("embeddingData", embeddingData);
//       embeddingData.map((data)=>{
//         mappings[data.index]['embeddingValues'] = data.embedding;
//       });

//       await TrainingList.findByIdAndUpdate(trainingList._id, { 
//         'mappings': mappings,  
//         'lastEdit': Date.now(),   
//         'trainingStatus': 4
//       });
//     }
//     catch(error) {
//       console.log("Error in snippet mapping");
//       await TrainingList.findByIdAndUpdate(trainingList._id, { 
//         'lastEdit': Date.now(),   
//         'trainingStatus': 19
//       });
//       console.log(error);
//     }    
//   }
//   catch(error) {
//     console.log("Error in createSnippet");
//     console.log(error);
//   }
// };

ScraperController.createSnippet = async (req, res) => {
  try {
    const { title, content } = req.body;
    console.log(req.body, "create snippet body");
    const file = req.file;
    const userId = req.body.userId;


    const snippetData = title && content
      ? {
          title,
          content,
        }
      : null;

    if(snippetData) {
      const trainingList1 = new TrainingList({
        userId,
        title,
        type: 2,
        snippet: snippetData,
      });
      await trainingList1.save();

      try {             
        // Mapping
        const input =[];
        async function splitContentAndMapping(content, maxLength) {
          const parts = [];
          let start = 0;  
          while (start < content.length) {
              const part = content.slice(start, start+maxLength);
              parts.push({ content: part });
              input.push(part);
              start += maxLength;
          } 
          return parts;
        }
        const maxLength = 1200;
        const mappings = await splitContentAndMapping(content, maxLength);
        const embeddingData = await OpenAIController.createEmbedding(input);
        // console.log("embeddingData", embeddingData);
        embeddingData.map((data)=>{
          mappings[data.index]['embeddingValues'] = data.embedding;
        });
        await TrainingList.findByIdAndUpdate(trainingList1._id, { 
          'mappings': mappings,  
          'lastEdit': Date.now(),   
          'trainingStatus': 4
        });
      }
      catch(error) {
        console.log("Error in snippet mapping");
        await TrainingList.findByIdAndUpdate(trainingList1._id, { 
          'lastEdit': Date.now(),   
          'trainingStatus': 19
        });
        console.log(error);
      }
    }

    let fileData = null;
    if (file) {
      const filePath = path.join(__dirname, '..', file.path);
      const fileContent = await readFileContent(filePath, file.mimetype);
      fileData = {
        fileName: file.filename,
        originalFileName: file.originalname,
        path: file.path,
        content: fileContent,
      };
      
      const trainingList2 = new TrainingList({
        userId,
        title: file.originalname,
        type: 3,
        file: fileData,
      });
      await trainingList2.save();

      try {            
        // Mapping
        const input =[];
        async function splitContentAndMapping(content, maxLength) {
          const parts = [];
          let start = 0;  
          while (start < content.length) {
              const part = content.slice(start, start+maxLength);
              parts.push({ content: part });
              input.push(part);
              start += maxLength;
          }   
          return parts;
        }  
        const maxLength = 1200;
        const mappings = await splitContentAndMapping(fileContent, maxLength);
        const embeddingData = await OpenAIController.createEmbedding(input);
        // console.log("embeddingData", embeddingData);
        embeddingData.map((data)=>{
          mappings[data.index]['embeddingValues'] = data.embedding;
        });
  
        await TrainingList.findByIdAndUpdate(trainingList2._id, { 
          'mappings': mappings,  
          'lastEdit': Date.now(),   
          'trainingStatus': 4
        });
      }
      catch(error) {
        console.log("Error in snippet mapping");
        await TrainingList.findByIdAndUpdate(trainingList2._id, { 
          'lastEdit': Date.now(),   
          'trainingStatus': 19
        });
        console.log(error);
      }
    }

    res.status(201).json({ status_code: 200, message: "Document Saved." });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error in creating snippet, please try again later.' });
  }
};

ScraperController.createFaq = async (req, res) => {
  const { question, answer } = req.body;
  const userId = req.body.userId;
  try {
    // const client = await Client.findOne({userId});
    const trainingList = new TrainingList({
      userId,
      title: question,
      type: 1,
      faq: {
        question,
        answer
      }
    });
    await trainingList.save();
    res.status(201).json({ status_code: 200, message: "FAQ added." });

    try {
      const embeddingData = await OpenAIController.createEmbedding(question);
      const embeddingValues = embeddingData[0].embedding;
      const mappings = [{
        'content': "Question: ["+question+"] \nAnswer: ["+answer+"]",
        embeddingValues
      }]

      await TrainingList.findByIdAndUpdate(trainingList._id, { 
        'mappings': mappings,  
        'lastEdit': Date.now(),   
        'trainingStatus': 4
      });
    }
    catch(error) {
      console.log("Error in faq mapping");
      await TrainingList.findByIdAndUpdate(trainingList._id, { 
        'lastEdit': Date.now(),   
        'trainingStatus': 29
      });
      console.log(error);
    }
  }
  catch(error) {
    console.log("Error in createFaq");
    console.log(error);
  }
};

ScraperController.toggleActiveStatus = async (req, res) => {
  const { id } = req.body;
  // console.log("toggle "+id);
  // const userId = req.body.userId;
  try {
    await TrainingList.findByIdAndUpdate(id, { 
      $bit: { 'isActive': { xor: 1 } }
    });
    res.status(201).json({ status_code: 200, message: "Status changed." });
  }
  catch(error) {
    console.log("Error in status change");
    console.log(error);
  }
};

module.exports = ScraperController;
