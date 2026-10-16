const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const User = require("../models/User");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const Widget = require("../models/Widget");
const PlanService = require("./PlanService");
const HumanAgent = require("../models/HumanAgent");
const commonHelper = require("../helpers/commonHelper.js");
const { saveChatTranscriptSettings } = require("../controllers/ChatTranscriptController.js");

/**
 * Create an agent + widget for an existing user and (optionally) bind them to
 * a store. When a client HumanAgent already exists the new agent is added to
 * its assignedAgents.
 */
async function createAgentWithWidget({ userId, storeHash = null }) {
  const agentId = new mongoose.Types.ObjectId();
  const qdrantIndexNamePaid = `${crypto.randomBytes(16).toString("hex")}-${agentId}`;
  const agent = new Agent({
    _id: agentId,
    userId,
    storeHash,
    qdrantIndexName: `${userId}-${agentId}`,
    qdrantIndexNamePaid,
  });

  const widgetToken =
    crypto.randomBytes(8).toString("hex") + userId + agent._id;
  const widget = new Widget({
    userId,
    widgetToken,
    agentId: agent._id,
  });

  await Promise.all([agent.save(), widget.save()]);
  return agent;
}

async function provisionNewMerchantUser({ email, name, provider, storeHash = null }) {
  const newUser = new User({
    email,
    role: "client",
    email_verified: true,
    provider,
    password: crypto.randomBytes(16).toString("hex"),
  });
  await newUser.save();

  const newClient = new Client({
    userId: newUser._id,
    email,
  });

  const [agent] = await Promise.all([
    createAgentWithWidget({ userId: newUser._id, storeHash }),
    newClient.save(),
  ]);

  await PlanService.seedCustomLimitsForNewClient(newUser._id);

  const agentPassword = crypto.randomBytes(16).toString("hex");
  const hashedPassword = await bcrypt.hash(agentPassword, 10);
  const humanAgent = new HumanAgent({
    name: commonHelper.clientHumanAgentNameFromAgent(agent),
    email,
    password: hashedPassword,
    userId: newUser._id,
    status: "approved",
    isClient: true,
    avatar: "",
    assignedAgents: [agent._id],
  });
  const humanAgentPromise = humanAgent.save();

  await Promise.all([
    humanAgentPromise,
    saveChatTranscriptSettings(newUser._id, [email], [email], [email]),
  ]);

  return { newUser, newClient };
}

/**
 * An existing user (same email) installs the app on an additional store:
 * give that store its own agent + widget and assign it to the client
 * human agent so it shows up in the inbox.
 */
async function provisionAgentForStore({ userId, storeHash }) {
  const agent = await createAgentWithWidget({ userId, storeHash });
  await HumanAgent.findOneAndUpdate(
    { userId, isClient: true },
    { $addToSet: { assignedAgents: agent._id } },
  );
  return agent;
}

module.exports = {
  provisionNewMerchantUser,
  provisionAgentForStore,
};
