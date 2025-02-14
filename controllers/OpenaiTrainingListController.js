/* OpenAI */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const officeParser = require("officeparser");

const { OpenAIEmbeddings } = require("@langchain/openai");
const { MarkdownTextSplitter } = require("langchain/text_splitter");
const { Pinecone } = require("@pinecone-database/pinecone");

const axios = require("axios");
const cheerio = require("cheerio");
const Client = require("../models/Client");
const Sitemap = require("../models/Sitemap");
const TrainingList = require("../models/OpenaiTrainingList");
const urlModule = require("url");

const commonHelper = require("../helpers/commonHelper.js");
const ObjectId = require("mongoose").Types.ObjectId;

const OpenaiTrainingListController = {};
const clientStatus = {};

// let contentProcessor; // Declare contentProcessor outside
const allowedTags = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd","a" ]; // Define allowedTags

class VectorStoreManager {
  constructor(pineconeIndexName) {
    this.pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      maxRetries: 5,
    });

    this.pineconeIndex = this.pineconeClient.index(
      //process.env.PINECONE_INDEX_NAME
      pineconeIndexName
    );

    // Initialize OpenAI embeddings
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }
  // generateVectorId(chunk) {
  //   // Create a hash from the chunk text (can be customized if needed)
  //   return crypto.createHash('sha256').update(chunk).digest('hex');
  // }
  

  async upsertVectors(chunks, metadata) {
    try {
        const batchSize = 100; // Adjust based on your needs
        const upsertBatches = [];
        let vectorId = 0;

        // Create embeddings for chunks
        const embeddings = await this.embeddings.embedDocuments(chunks);

        // Create upsert objects with metadata
        const pageVectors = embeddings.map((embedding, i) => ({ 
            // id: this.generateVectorId(chunks[i]), // Use your vector ID generation
            id: `vec${vectorId + i}`,
            values: embedding,
            metadata: {
                text: chunks[i],
                ...metadata,
                chunk_index: i,
                total_chunks: chunks.length
            }
        }));

        // Add vectors to batches
        for (let i = 0; i < pageVectors.length; i += batchSize) {
            upsertBatches.push(pageVectors.slice(i, i + batchSize));
        }

        // Upsert batches to Pinecone
        console.log(`Upserting ${pageVectors.length} vectors in ${upsertBatches.length} batches`);

        for (let i = 0; i < upsertBatches.length; i++) {
            const batch = upsertBatches[i];
            await this.pineconeIndex.upsert(batch);
            console.log(`Upserted batch ${i + 1}/${upsertBatches.length}`);
        }

        return { success: true, vectorCount: pageVectors.length };

    } catch (error) {
        console.error("Error upserting vectors to Pinecone:", error);
        return { success: false, error };
    }
}

async doesIndexExist() {
  try {
      const indexList = await this.pineconeClient.listIndexes();
      return indexList.indexes.some(index => index.name === this.pineconeIndexName);
  } catch (error) {
      console.error("Error checking if index exists:", error);
      return false; // Assume it doesn't exist in case of an error
  }
}

async createIndex() {
try {
    await this.pineconeClient.createIndex({
        name: this.pineconeIndexName,
        dimension: 1536, // Specify the embedding dimension (OpenAI ada)
        metric: 'cosine' //  Appropriate metric for semantic search
    });
    console.log(`Pinecone index "${this.pineconeIndexName}" created successfully.`);
    // Optionally, wait for the index to be ready
    await this.waitForIndexCreation();
    return true;
} catch (error) {
    console.error(`Error creating Pinecone index "${this.pineconeIndexName}":`, error);
    return false;
}
}

async waitForIndexCreation(timeout = 60000) {  // Default timeout: 60 seconds
const startTime = Date.now();
while (Date.now() - startTime < timeout) {
    try {
        const indexDescription = await this.pineconeClient.describeIndex(this.pineconeIndexName);
        if (indexDescription.status.ready) {
            console.log(`Pinecone index "${this.pineconeIndexName}" is ready.`);
            return;
        }
    } catch (error) {
        console.warn(`Error describing index "${this.pineconeIndexName}", retrying...`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
}
throw new Error(`Timeout waiting for Pinecone index "${this.pineconeIndexName}" to be created.`);
}


}

class TrainingPricingCalculator {
  constructor() {
    // Current pricing rates (as of 2024)
    this.rates = {
      embedding: {
        ada: 0.0001, // per 1K tokens
      },
      chatCompletion: {
        "gpt-3.5-turbo": {
          input: 0.001, // per 1K tokens
          output: 0.002, // per 1K tokens
        },
      },
      pinecone: {
        query: 0.0002, // per query
        vector: 0.0002, // per vector per month
      },
    };
  }

  async estimateTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  calculateEmbeddingCost(tokens) {
    return (tokens / 1000) * this.rates.embedding.ada;
  }

  calculateChatCompletionCost(
    inputTokens,
    outputTokens,
    model = "gpt-3.5-turbo"
  ) {
    const inputCost =
      (inputTokens / 1000) * this.rates.chatCompletion[model].input;
    const outputCost =
      (outputTokens / 1000) * this.rates.chatCompletion[model].output;
    return inputCost + outputCost;
  }

  calculatePineconeQueryCost(queryCount) {
    return queryCount * this.rates.pinecone.query;
  }

  calculatePineconeStorageCost(ChunkLength) {
    return ChunkLength * this.rates.pinecone.vector;
  }
}

class ContentProcessor {
  constructor(pineconeIndexName) {
    this.textSplitter = new MarkdownTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    this.vectorStoreManager = new VectorStoreManager(pineconeIndexName);
    this.pricingCalculator = new TrainingPricingCalculator();
  }


  async readFileContent(filePath, mimeType) {
    return new Promise((resolve, reject) => {
      if (mimeType === "text/plain") {
        fs.readFile(filePath, "utf8", (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      } else if (mimeType === "application/pdf") {
        fs.readFile(filePath, (err, data) => {
          if (err) reject(err);
          pdfParse(data)
            .then((data) => resolve(data.text))
            .catch(reject);
        });
      } else if (
        mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        mammoth
          .extractRawText({ path: filePath })
          .then((result) => resolve(result.value))
          .catch(reject);
      } else if (mimeType === "application/msword") {
        officeParser.parseOfficeAsync(filePath, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      } else {
        resolve("");
      }
    });
  }

   async processWebPage(trainingListObj, req,pineconeIndexName) {
      try {
        await TrainingList.findByIdAndUpdate(trainingListObj._id, {
          "trainingProcessStatus.minifyingStatus": 1,
          "trainingProcessStatus.minifyingDuration.start": Date.now(),
        });
  
        const sourceCode = trainingListObj.webPage.sourceCode;
        const $ = cheerio.load(sourceCode);
        const webPageURL = trainingListObj.webPage.url;
  
        // Handle singular tags appropriately
        const title = $("title").text();
        const metaDescription = $('meta[name="description"]').attr("content");
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
        $("a").each((i, el) => {
          const href = $(el).attr("href");
          if (href && !href.startsWith("http") && href !== "#") {
            // !href.startsWith('#')
            $(el).attr("href", convertToAbsoluteUrl(href, webPageURL));
          }
        });
  
        // Replace iframes with a message or remove them if no src attribute
        $("iframe").each((i, el) => {
          const src = $(el).attr("src");
          if (src) {
            $(el).replaceWith(`${convertToAbsoluteUrl(src, webPageURL)}`);
          } else {
            $(el).remove();
          }
        });
  
        // Replace form elements with a message
        $("form").each((i, el) => {
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
  
        const content = $("body").html().replace(/\s+/g, " ").trim();
  
        // Split content into chunks using LangChain's text splitter
        const chunks = await this.textSplitter.createDocuments([content], {
          url: webPageURL,
          title: title,
          type: "webpage",
          userId: trainingListObj.userId,
        });
  
        // Calculate costs
        const totalTokens = await this.pricingCalculator.estimateTokens(content);
        const embeddingCost = this.pricingCalculator.calculateEmbeddingCost(totalTokens);
        // const storageCost = this.pricingCalculator.calculatePineconeStorageCost(chunks.length);
  
        // Upsert vectors into Pinecone
        req.io.to('user'+trainingListObj.userId).emit('web-page-status', { message: "Upserting vectors to pinecone" }); // Update client
        const upsertResult = await this.vectorStoreManager.upsertVectors(
          chunks.map(chunk => chunk.pageContent),
          {
            url: webPageURL,
            title: title,
            type: "webpage",
            userId: trainingListObj.userId,
          }
        );
        if (!upsertResult.success) {
          console.error("Failed to upsert vectors:", upsertResult.error);
          throw new Error("Failed to upsert vectors to Pinecone");
        }
  
        // Calculate costs
        // const embeddingCost = this.pricingCalculator.calculateEmbeddingCost(totalTokens);
        // const storageCost = this.pricingCalculator.calculatePineconeStorageCost(upsertResult.vectorCount);
  
        // Update training list with status
        await TrainingList.findByIdAndUpdate(trainingListObj._id, {
          "webPage.title": title,
          "webPage.metaDescription": metaDescription,
          "webPage.content": content,
          costDetails: {
            tokens: totalTokens,
            embedding: embeddingCost,
            storage: storageCost,
            totalCost: embeddingCost + storageCost,
          },
          "trainingProcessStatus.minifyingStatus": 2,
          "trainingProcessStatus.minifyingDuration.end": Date.now(),
          trainingStatus: 4,
        });
  
        return { success: true, chunks: chunks.length };
      } catch (error) {
        console.error("Error processing webpage:", error);
        await TrainingList.findByIdAndUpdate(trainingListObj._id, {
          "trainingProcessStatus.minifyingStatus": 3,
          trainingStatus: 9,
        });
        return { success: false, error };
      }
    }

  async processFileOrSnippet(data) {
    try {
      let content, metadata;

      if (data.file) {
        content = await this.readFileContent(
          data.file.path,
          data.file.mimetype
        );
        metadata = {
          title: data.file.originalname,
          type: "file",
          mimeType: data.file.mimetype,
          userId: data.userId,
        };
      } else {
        content = data.content;
        metadata = {
          title: data.title,
          type: "snippet",
          userId: data.userId,
        };
      }

      const chunks = await this.textSplitter.createDocuments([content], {
        metadata,
      });

      const totalTokens = await this.pricingCalculator.estimateTokens(content);
      const embeddingCost = this.pricingCalculator.calculateEmbeddingCost(totalTokens);
      const storageCost = this.pricingCalculator.calculatePineconeStorageCost(chunks.length);

      const upsertResult = await this.vectorStoreManager.upsertVectors(
        chunks.map(chunk => chunk.pageContent),
        metadata // Pass metadata here
      );
      if (!upsertResult.success) {
        console.error("Failed to upsert vectors:", upsertResult.error);
        throw new Error("Failed to upsert vectors to Pinecone");
      }

      return {
        success: true,
        costs: {
          tokens: totalTokens,
          embedding: embeddingCost,
          storage: storageCost,
          total: embeddingCost + storageCost,
        },
        chunks: chunks.length,
      };
    } catch (error) {
      console.error("Error processing file/snippet:", error);
      return { success: false, error };
    }
  }
}

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
    let contentProcessor = new ContentProcessor(pineconeIndexName);
    const result = await contentProcessor.processFileOrSnippet({
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
              await createTrainingListAndWebPages(webPageLocs, userId, sitemapObj._id);
              req.io.to('user'+userId).emit('web-pages-added');
              webPageCrawling(client, userId, req, pineconeIndexName);
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

async function webPageMinifying(client, userId, req,pineconeIndexName) {
  try {
    if(clientStatus[userId] && clientStatus[userId].webPageMinifying) {
      // setTimeout
      return;
    }
    clientStatus[userId] = { webPageMinifying: true };
    let trainingListObjArray = [];
    do {
      trainingListObjArray = await TrainingList.find({
        userId,
        type: 0,
        // 'webPage.crawlingStatus': 2,
        trainingStatus: 2
      }).limit(10);

      // Initialize ContentProcessor outside the loop
      const contentProcessor = new ContentProcessor(pineconeIndexName);
      // await contentProcessor.initialize();

      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {
        try {
          const processResult = await contentProcessor.processWebPage(trainingListObj, req,pineconeIndexName);

          if (!processResult.success) {
            console.error(`Error processing ${trainingListObj.webPage.url}:`, processResult.error);
            await TrainingList.findByIdAndUpdate(trainingListObj._id, {
              'lastEdit': Date.now(),
              'trainingProcessStatus.minifyingStatus': 3,
              'trainingStatus': 9
            });
            trainingListObj.trainingStatus = 9;
          } else {
            console.log(`Successfully processed ${trainingListObj.webPage.url}`);
            trainingListObj.trainingStatus = 3; // Mark as minified
          }
        } catch (error) {
          console.error(`Unexpected error during processing ${trainingListObj.webPage.url}:`, error);
          await TrainingList.findByIdAndUpdate(trainingListObj._id, {
            'lastEdit': Date.now(),
            'trainingProcessStatus.minifyingStatus': 3,
            'trainingStatus': 9
          });
          trainingListObj.trainingStatus = 9;
        }
      }));

      if (trainingListObjArray.length) {
        const list = trainingListObjArray.map(({ _id, trainingStatus }) => ({ _id, trainingStatus }));
        req.io.to('user' + userId).emit('web-pages-minified', {
          list
        });

        //webPageMapping(client, userId, req);
      }
    } while (trainingListObjArray.length > 0);
    // }
    clientStatus[userId] = { webPageMinifying: false };
  } catch (error) {
    console.error("Error in webpage mapping", error);
    clientStatus[userId] = { webPageMinifying: false };
  }
}

async function webPageCrawling(client, userId, req,pineconeIndexName) {
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
      }).limit(10);
      
      await Promise.all(trainingListObjArray.map(async (trainingListObj) => {        
        await TrainingList.findByIdAndUpdate(trainingListObj._id, { 
          'trainingProcessStatus.crawlingStatus': 1, 
          'trainingProcessStatus.crawlingDuration.start': Date.now()
        });
        const url = trainingListObj.webPage.url;        
        try {
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

        webPageMinifying(client, userId, req, pineconeIndexName);
      }
    } while (trainingListObjArray.length > 0); // Loop end
    clientStatus[userId] = { webPageCrawling: false };
  }
  catch(error) {
    console.error("Error in webpage scrapping", error);
    clientStatus[userId] = { webPageCrawling: false };
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

    let contentProcessor = new ContentProcessor(pineconeIndexName);
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
    // Step 1: Insert into TrainingList
    const trainingListDocuments = urls.map((url) => ({
      userId: userId,
      title: url,
      type: 0,

      webPage: {
        url,
        sitemapIds: [sitemapId],
      },
    }));

    const trainingListResult = await TrainingList.insertMany(
      trainingListDocuments
    ); //, { session }
  } catch (error) {
    console.error("Error inserting data:", error);
  }
}

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

module.exports = OpenaiTrainingListController;