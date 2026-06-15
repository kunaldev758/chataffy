const Agent = require("../models/Agent");
const {
  hostnameFromUrlLike,
  looksLikeHostnameOrDomain,
} = require("./commonHelper");

function collectWebsiteHostsFromAgent(agent) {
  const hosts = new Set();
  const add = (input) => {
    const h = hostnameFromUrlLike(input);
    if (h) hosts.add(h.toLowerCase());
  };

  if (!agent) return hosts;

  if (agent.onboardingWebsiteUrl) add(agent.onboardingWebsiteUrl);
  if (agent.website_name) add(agent.website_name);
  if (agent.agentName && looksLikeHostnameOrDomain(agent.agentName)) {
    add(agent.agentName);
  }
  if (Array.isArray(agent.onboardingExtractedUrls)) {
    for (const url of agent.onboardingExtractedUrls) {
      add(url);
    }
  }

  return hosts;
}

/**
 * Returns another agent under the same account that already uses this website host.
 */
async function findDuplicateWebsiteAgent(userId, websiteUrl, excludeAgentId) {
  const targetHost = hostnameFromUrlLike(websiteUrl);
  if (!targetHost || !userId) return null;

  const normalizedTarget = targetHost.toLowerCase();
  const query = { userId, isDeleted: false };
  if (excludeAgentId) {
    query._id = { $ne: excludeAgentId };
  }

  const agents = await Agent.find(query).select(
    "_id agentName website_name onboardingWebsiteUrl onboardingExtractedUrls",
  );

  for (const agent of agents) {
    const hosts = collectWebsiteHostsFromAgent(agent);
    if (hosts.has(normalizedTarget)) {
      return agent;
    }
  }

  return null;
}

module.exports = {
  collectWebsiteHostsFromAgent,
  findDuplicateWebsiteAgent,
};
