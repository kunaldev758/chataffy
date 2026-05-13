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


async function provisionNewMerchantUser({ email, name, provider }) {
  const newUser = new User({
    email,
    role: "client",
    email_verified: true,
    provider,
    password: crypto.randomBytes(16).toString("hex"),
  });
  await newUser.save();

  const agentId = new mongoose.Types.ObjectId();
  const qdrantIndexNamePaid = `${crypto.randomBytes(16).toString("hex")}-${agentId}`;
  const agent = new Agent({
    _id: agentId,
    userId: newUser._id,
    qdrantIndexName: `${newUser._id}-${agentId}`,
    qdrantIndexNamePaid,
  });

  const newClient = new Client({
    userId: newUser._id,
    email,
  });

  await Promise.all([agent.save(), newClient.save()]);

  const widgetToken =
    crypto.randomBytes(8).toString("hex") + newUser._id + agent._id;
  const newWidget = new Widget({
    userId: newUser._id,
    widgetToken,
    agentId: agent._id,
  });

  await PlanService.seedCustomLimitsForNewClient(newUser._id);

  const widgetPromise = newWidget.save();

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
    widgetPromise,
    humanAgentPromise,
    saveChatTranscriptSettings(newUser._id, [email], [email], [email]),
  ]);

  return { newUser, newClient };
}

module.exports = {
  provisionNewMerchantUser,
};
