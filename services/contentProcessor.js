const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const officeParser = require("officeparser");
const cheerio = require("cheerio");
const urlModule = require("url");

const { OpenAIEmbeddings } = require("@langchain/openai");
const { MarkdownTextSplitter } = require("langchain/text_splitter");
const { Pinecone } = require("@pinecone-database/pinecone");

const TrainingPricingCalculator = require("./trainingPricingCalculator");

class VectorStoreManager {
  constructor(pineconeIndexName) {
    this.pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      environment: process.env.PINEONE_ENVIRONMENT,
    });

    this.pineconeIndex = this.pineconeClient.index(pineconeIndexName);

    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  async upsertVectors(chunks, metadata) {
    try {
      const batchSize = 100;
      const upsertBatches = [];
      let vectorId = 0;

      const embeddings = await this.embeddings.embedDocuments(chunks);

      const pageVectors = embeddings.map((embedding, i) => ({
        id: `vec${vectorId + i}`,
        values: embedding,
        metadata: {
          text: chunks[i],
          ...metadata,
          chunk_index: i,
          total_chunks: chunks.length,
        },
      }));

      for (let i = 0; i < pageVectors.length; i += batchSize) {
        upsertBatches.push(pageVectors.slice(i, i + batchSize));
      }

      console.log(
        `Upserting ${pageVectors.length} vectors in ${upsertBatches.length} batches`
      );

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

  async doesIndexExist(pineconeIndexName) {
    try {
      const indexList = await this.pineconeClient.listIndexes();
      return indexList.indexes.some((index) => index.name === pineconeIndexName);
    } catch (error) {
      console.error("Error checking if index exists:", error);
      return false;
    }
  }

  async createIndex(pineconeIndexName) {
    try {
      let spec = {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      };

      await this.pineconeClient.createIndex({
        name: pineconeIndexName,
        dimension: 1536,
        metric: "cosine",
        spec: spec,
      });
      console.log(
        `Pinecone index "${this.pineconeIndexName}" created successfully.`
      );
      await this.waitForIndexCreation(pineconeIndexName);
      return true;
    } catch (error) {
      console.error(
        `Error creating Pinecone index "${this.pineconeIndexName}":`,
        error
      );
      return false;
    }
  }

  async waitForIndexCreation(pineconeIndexName, timeout = 60000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const indexDescription = await this.pineconeClient.describeIndex(
          pineconeIndexName
        );
        if (indexDescription.status.ready) {
          console.log(`Pinecone index "${pineconeIndexName}" is ready.`);
          return;
        }
      } catch (error) {
        console.warn(
          `Error describing index "${pineconeIndexName}", retrying...`,
          error.message
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `Timeout waiting for Pinecone index "${pineconeIndexName}" to be created.`
    );
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

  async processWebPage(trainingListObj) {
    try {
      const sourceCode = trainingListObj.webPage.sourceCode;
      const $ = cheerio.load(sourceCode);
      const webPageURL = trainingListObj.webPage.url;

      const allowedTags = [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "a",
      ]; // Define allowedTags

      const title = $("title").text();
      const metaDescription = $('meta[name="description"]').attr("content");
      $("br, hr").remove();
      $("style, script").remove();
      $("*")
        .contents()
        .filter(function () {
          return this.nodeType === 8;
        })
        .remove();
      $("img, input").remove();

      function convertToAbsoluteUrl(relativeUrl, baseUrl) {
        return urlModule.resolve(baseUrl, relativeUrl);
      }

      $("a").each((i, el) => {
        const href = $(el).attr("href");
        if (href && !href.startsWith("http") && href !== "#") {
          $(el).attr("href", convertToAbsoluteUrl(href, webPageURL));
        }
      });

      $("iframe").each((i, el) => {
        const src = $(el).attr("src");
        if (src) {
          $(el).replaceWith(`${convertToAbsoluteUrl(src, webPageURL)}`);
        } else {
          $(el).remove();
        }
      });

      $("form").each((i, el) => {
        $(el).prepend(`Form on URL: ${webPageURL}`);
      });

      function replaceNonAllowedTags(element) {
        $(element)
          .contents()
          .each(function () {
            if (this.nodeType === 1) {
              replaceNonAllowedTags(this);
              if (!allowedTags.includes(this.name)) {
                const childNodes = $(this)
                  .children()
                  .filter(function () {
                    return this.nodeType === 1;
                  });

                if (childNodes.length === 1) {
                  const innerHtml = $(this).html() || "";
                  $(this).replaceWith(innerHtml);
                }
              }
            }
          });
      }
      replaceNonAllowedTags("body");

      function removeEmptyElements(element) {
        $(element)
          .contents()
          .each(function () {
            if (this.nodeType === 1) {
              removeEmptyElements(this);
              if ($(this).is(":empty") || /^\s*$/.test($(this).text())) {
                $(this).remove();
              }
            }
          });
      }
      removeEmptyElements("body");
      $("*").each(function () {
        if ($(this).is("p, h1, h2, h3, h4, h5, h6, li")) {
          $(this)
            .contents()
            .filter(function () {
              return this.nodeType === 3;
            })
            .each(function () {
              this.nodeValue = this.nodeValue.trim();
            });
        }
      });

      $("*").each(function () {
        const allowedAttributes = ["src", "href"];
        const attributes = this.attribs;

        for (const attr in attributes) {
          if (attributes[attr] && !allowedAttributes.includes(attr)) {
            delete attributes[attr];
          }
        }
      });

      const content = $("body").html().replace(/\s+/g, " ").trim();

      const chunks = await this.textSplitter.createDocuments([content], {
        url: webPageURL,
        title: title,
        type: "webpage",
        userId: trainingListObj.userId,
      });

      const totalTokens = await this.pricingCalculator.estimateTokens(content);
      const embeddingCost = this.pricingCalculator.calculateEmbeddingCost(
        totalTokens
      );
      // const storageCost = this.pricingCalculator.calculatePineconeStorageCost(chunks.length);
      try {
        // const usage = new UsageRoutes();
        // UsageRoutes.addUsage(userId, "question", costs.total);
      } catch (error) {
        throw new Error("Not Enough Credits");
      }

      const upsertResult = await this.vectorStoreManager.upsertVectors(
        chunks.map((chunk) => chunk.pageContent),
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

      return {
        success: true,
        chunks: chunks.length,
        title: title,
        metaDescription: metaDescription,
        content: content,
        totalTokens: totalTokens,
        embeddingCost: embeddingCost,
        storageCost: 0,
      };
    } catch (error) {
      console.error("Error processing webpage:", error);
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
      const embeddingCost = this.pricingCalculator.calculateEmbeddingCost(
        totalTokens
      );
      const storageCost = this.pricingCalculator.calculatePineconeStorageCost(
        chunks.length
      );

      try {
        // const usage = new UsageRoutes();
        // UsageRoutes.addUsage(userId, "question", costs.total);
      } catch (error) {
        throw new Error("Not Enough Credits");
      }

      const upsertResult = await this.vectorStoreManager.upsertVectors(
        chunks.map((chunk) => chunk.pageContent),
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

module.exports = ContentProcessor;