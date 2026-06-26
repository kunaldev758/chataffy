const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const {
  planUpgradeQueue,
  urlProcessingQueue,
  deleteTrainingDataQueue,
  retrainTrainingDataQueue,
  transcriptEmailQueue,
} = require("./jobService");

const BULL_BOARD_BASE_PATH = "/api/superadmin/queues";

function setupBullBoard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);

  createBullBoard({
    queues: [
      new BullMQAdapter(planUpgradeQueue),
      new BullMQAdapter(urlProcessingQueue),
      new BullMQAdapter(deleteTrainingDataQueue),
      new BullMQAdapter(retrainTrainingDataQueue),
      new BullMQAdapter(transcriptEmailQueue),
    ],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}

module.exports = {
  setupBullBoard,
  BULL_BOARD_BASE_PATH,
};
