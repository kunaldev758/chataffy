const { Queue } = require("bullmq");

const redisOptions = {
  connection: {
    url: process.env.REDIS_URL,
    maxRetriesPerRequest: null,
  },
};

const scrapeQueue = new Queue("scrapeQueue", redisOptions);

module.exports = scrapeQueue;