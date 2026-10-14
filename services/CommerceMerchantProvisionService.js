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
 * Idempotent: guarantees the merchant's "client" HumanAgent (isClient: true)
 * exists for the given user. Safe to call on every install / load, so it also
 * repairs accounts whose first provisioning failed part-way.
 */
async function ensureMerchantHumanAgent({ userId, email }) {
  if (!userId) return null;

  const agents = await Agent.find({ userId, isDeleted: { $ne: true } })
    .select("_id agentName website_name onboardingWebsiteUrl")
    .lean();
  const agentIds = agents.map((a) => a._id);

  const existing = await HumanAgent.findOne({ userId, isClient: true });
  if (existing) {
    const assigned = new Set((existing.assignedAgents || []).map(String));
    const missing = agentIds.filter((id) => !assigned.has(String(id)));
    let dirty = false;
    if (missing.length) {
      existing.assignedAgents = [...(existing.assignedAgents || []), ...missing];
      dirty = true;
    }
    if (existing.status !== "approved") {
      existing.status = "approved";
      dirty = true;
    }
    if (existing.isDeleted) {
      existing.isDeleted = false;
      dirty = true;
    }
    if (dirty) await existing.save();
    return existing;
  }

  const resolvedEmail = (
    email ||
    (await User.findById(userId).select("email").lean())?.email ||
    ""
  )
    .trim()
    .toLowerCase();
  if (!resolvedEmail) {
    console.error("[ensureMerchantHumanAgent] No email for user", String(userId));
    return null;
  }

  const hashedPassword = await bcrypt.hash(
    crypto.randomBytes(16).toString("hex"),
    10,
  );
  try {
    const humanAgent = new HumanAgent({
      name: commonHelper.clientHumanAgentNameFromAgent(agents[0]),
      email: resolvedEmail,
      password: hashedPassword,
      userId,
      status: "approved",
      isClient: true,
      avatar: "",
      assignedAgents: agentIds,
    });
    await humanAgent.save();
    console.log("[ensureMerchantHumanAgent] Created human agent for", resolvedEmail);
    return humanAgent;
  } catch (err) {
    // E11000 = a HumanAgent with this email already exists under another userId.
    console.error(
      "[ensureMerchantHumanAgent] Failed to create human agent:",
      err.code,
      err.message,
    );
    return null;
  }
}

module.exports = {
  provisionNewMerchantUser,
  ensureMerchantHumanAgent,
};
