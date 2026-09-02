const Client = require("../models/Client");

/**
 * Push updated client plan/limit state to connected dashboard sockets.
 */
async function emitClientPlanStatusUpdate(userId, agentId, extraPayload = {}) {
  if (!userId) return;
  const client = await Client.findOne({ userId }).lean();
  if (!client) return;
  const appEvents = require("../events");
  appEvents.emit("userEvent", userId, agentId || null, "training-event", {
    client,
    ...extraPayload,
  });
}

module.exports = {
  emitClientPlanStatusUpdate,
};
