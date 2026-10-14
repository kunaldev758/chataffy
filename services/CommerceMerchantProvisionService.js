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

/**
 * Idempotent: guarantees the merchant (User) has a client "Admin" HumanAgent
 * (isClient: true). provisionNewMerchantUser only runs for brand-new users, so
 * existing users (same owner email across several stores, partially provisioned
 * users, older accounts) would otherwise never get one.
 */
async function ensureClientHumanAgent({ userId, email }) {
  if (!userId || !email) return null;

  const normalizedEmail = String(email).trim().toLowerCase();
  const agents = await Agent.find({ userId, isDeleted: { $ne: true } }).select(
    "_id agentName website_name onboardingWebsiteUrl",
  );
  const agentIds = agents.map((a) => a._id);

  const existing = await HumanAgent.findOne({ userId, isClient: true });
  if (existing) {
    if (agentIds.length) {
      await HumanAgent.updateOne(
        { _id: existing._id },
        { $addToSet: { assignedAgents: { $each: agentIds } } },
      );
    }
    return existing;
  }

  // HumanAgent.email is globally unique: reuse the record if it is this user's own
  const sameEmail = await HumanAgent.findOne({ email: normalizedEmail });
  if (sameEmail) {
    if (String(sameEmail.userId) !== String(userId)) {
      console.error(
        "[ensureClientHumanAgent] email already used by another user:",
        normalizedEmail,
      );
      return null;
    }
    sameEmail.isClient = true;
    sameEmail.status = "approved";
    sameEmail.isDeleted = false;
    await sameEmail.save();
    if (agentIds.length) {
      await HumanAgent.updateOne(
        { _id: sameEmail._id },
        { $addToSet: { assignedAgents: { $each: agentIds } } },
      );
    }
    return sameEmail;
  }

  const password = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10);
  try {
    return await HumanAgent.create({
      name: commonHelper.clientHumanAgentNameFromAgent(agents[0]),
      email: normalizedEmail,
      password,
      userId,
      status: "approved",
      isClient: true,
      avatar: "",
      assignedAgents: agentIds,
    });
  } catch (err) {
    // Concurrent calls (callback + load) can race; return the winner's record.
    if (err?.code === 11000) {
      return HumanAgent.findOne({ userId, isClient: true });
    }
    throw err;
  }
}

module.exports = {
  provisionNewMerchantUser,
  ensureClientHumanAgent,
};
