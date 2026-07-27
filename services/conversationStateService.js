const Conversation = require("../models/Conversation");
const { extractSizeTokens } = require("../utils/queryNormalization");
const {
  extractCollectionHints,
} = require("../utils/queryContextExpansion");

const NON_RAG_CLEAR_ROUTES = new Set(["GREETING", "LIVE_AGENT", "ACCIDENTAL"]);

/** Set on ragState.awaiting when the assistant ends with a soft offer for more detail. */
const AWAITING_FOLLOW_UP = "follow_up";

function createEmptyRagState() {
  return {
    lastIntent: null,
    topic: null,
    entities: {
      product: null,
      sizes: [],
      collection: null,
      productTerms: [],
      compare: [],
    },
    lastStandaloneQuery: null,
    awaiting: null,
    turn: 0,
    updatedAt: null,
  };
}

function isAwaitingFollowUp(state) {
  return normalizeRagState(state).awaiting === AWAITING_FOLLOW_UP;
}

function normalizeRagState(raw) {
  const empty = createEmptyRagState();
  if (!raw || typeof raw !== "object") return empty;

  const entities = raw.entities && typeof raw.entities === "object"
    ? raw.entities
    : {};

  return {
    lastIntent: raw.lastIntent || null,
    topic: raw.topic || null,
    entities: {
      product: entities.product || null,
      sizes: Array.isArray(entities.sizes) ? entities.sizes.filter(Boolean) : [],
      collection: entities.collection || null,
      productTerms: Array.isArray(entities.productTerms)
        ? entities.productTerms.filter(Boolean)
        : [],
      compare: Array.isArray(entities.compare)
        ? entities.compare.filter(Boolean)
        : [],
    },
    lastStandaloneQuery: raw.lastStandaloneQuery || null,
    awaiting: raw.awaiting || null,
    turn: typeof raw.turn === "number" && raw.turn >= 0 ? raw.turn : 0,
    updatedAt: raw.updatedAt || null,
  };
}

function formatStateForRouter(state) {
  const normalized = normalizeRagState(state);
  const parts = [];

  if (normalized.topic) parts.push(`topic: ${normalized.topic}`);
  if (normalized.lastStandaloneQuery) {
    parts.push(`last query: ${normalized.lastStandaloneQuery}`);
  }

  const { entities } = normalized;
  if (entities.product) parts.push(`product: ${entities.product}`);
  if (entities.collection) parts.push(`collection: ${entities.collection}`);
  if (entities.sizes?.length) parts.push(`sizes: ${entities.sizes.join(", ")}`);
  if (entities.productTerms?.length) {
    parts.push(`terms: ${entities.productTerms.join(", ")}`);
  }
  if (Array.isArray(entities.compare) && entities.compare.length > 0) {
    parts.push(`compare: ${entities.compare.slice(0, 4).join(" | ")}`);
  }
  if (normalized.lastIntent) parts.push(`last intent: ${normalized.lastIntent}`);
  if (normalized.awaiting) parts.push(`awaiting: ${normalized.awaiting}`);

  return parts.length > 0 ? parts.join(" | ") : "";
}

function topicsFromRagState(state) {
  const normalized = normalizeRagState(state);
  const { entities } = normalized;
  const collections = [];

  if (entities.collection) collections.push(entities.collection);
  if (entities.product && !entities.collection) {
    for (const hint of extractCollectionHints(entities.product)) {
      collections.push(hint);
    }
  }
  if (normalized.lastStandaloneQuery) {
    for (const hint of extractCollectionHints(normalized.lastStandaloneQuery)) {
      collections.push(hint);
    }
  }

  return {
    sizes: [...new Set(entities.sizes || [])],
    collections: [...new Set(collections)],
    productTerms: [...new Set(entities.productTerms || [])],
  };
}

function hasCatalogThreadFromState(state) {
  const topics = topicsFromRagState(state);
  return (
    topics.sizes.length > 0 ||
    topics.collections.length > 0 ||
    topics.productTerms.length > 0 ||
    Boolean(normalizeRagState(state).lastStandaloneQuery)
  );
}

function extractEntitiesFromMatches(matches = [], queryAttributes = {}) {
  const entities = {
    product: queryAttributes?.collections?.[0] || null,
    sizes: [...new Set(queryAttributes?.sizes || [])],
    collection: queryAttributes?.collections?.[0] || null,
    productTerms: [],
  };

  const topMatches = (matches || []).slice(0, 3);
  for (const match of topMatches) {
    const payload = match?.payload || {};
    const title = String(payload.title || "").trim();
    const text = String(payload.text || "").slice(0, 500);
    const combined = `${title} ${text}`;

    for (const size of extractSizeTokens(combined)) {
      if (!entities.sizes.includes(size)) entities.sizes.push(size);
    }
    for (const hint of extractCollectionHints(combined)) {
      if (!entities.collection) entities.collection = hint;
    }
    if (/\b(lashes?|lash)\b/i.test(combined)) entities.productTerms.push("lash");
    if (/\b(collection|catalog)\b/i.test(combined)) {
      entities.productTerms.push("collection");
    }
    if (!entities.product && title && title.length <= 120) {
      entities.product = title;
    }
  }

  entities.productTerms = [...new Set(entities.productTerms)];
  return entities;
}

function inferTopic({ entities, lastStandaloneQuery, routing }) {
  if (entities?.collection) return entities.collection;
  if (entities?.product) return entities.product;
  if (lastStandaloneQuery) {
    const trimmed = lastStandaloneQuery.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  }
  if (routing?.subIntent) return routing.subIntent;
  return null;
}

function buildUpdatedRagState({
  currentState,
  routing = {},
  retrievalQuery,
  baseForEmbedding,
  queryAttributes = {},
  matches = [],
  clearEntities = false,
  awaiting = null,
}) {
  const current = normalizeRagState(currentState);
  const standalone =
    String(baseForEmbedding || retrievalQuery || "").trim() || null;

  if (clearEntities) {
    return {
      ...createEmptyRagState(),
      turn: current.turn + 1,
      updatedAt: new Date(),
    };
  }

  const entities = clearEntities
    ? createEmptyRagState().entities
    : extractEntitiesFromMatches(matches, queryAttributes);

  // Preserve compare entities for follow-ups (e.g. "which one is cheaper?").
  if (routing?.subIntent === "COMPARE" && Array.isArray(routing.entities)) {
    entities.compare = routing.entities
      .map((e) => (e?.name ? String(e.name) : e?.query ? String(e.query) : null))
      .filter(Boolean)
      .slice(0, 4);
  }

  const nextState = {
    lastIntent: routing.route || current.lastIntent,
    topic: inferTopic({
      entities,
      lastStandaloneQuery: standalone,
      routing,
    }),
    entities,
    lastStandaloneQuery: standalone || current.lastStandaloneQuery,
    awaiting: awaiting || null,
    turn: current.turn + 1,
    updatedAt: new Date(),
  };

  return nextState;
}

function buildAckRagState(currentState, routing = {}) {
  const current = normalizeRagState(currentState);
  return {
    ...current,
    lastIntent: routing.route || current.lastIntent,
    // Thanks / pure ack ends the soft-offer window
    awaiting: null,
    turn: current.turn + 1,
    updatedAt: new Date(),
  };
}

function shouldClearRagState(routing) {
  return NON_RAG_CLEAR_ROUTES.has(routing?.route);
}

function shouldClearEntitiesOnly(routing, isOffTopic = false) {
  return isOffTopic && routing?.route === "SEMANTIC_RAG";
}

async function loadRagState(conversationId) {
  if (!conversationId) return createEmptyRagState();
  const conversation = await Conversation.findById(conversationId)
    .select("ragState")
    .lean();
  return normalizeRagState(conversation?.ragState);
}

async function saveRagState(conversationId, state) {
  if (!conversationId) return;
  const normalized = normalizeRagState(state);
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        ragState: {
          ...normalized,
          updatedAt: new Date(),
        },
      },
    },
  );
}

async function clearRagState(conversationId) {
  if (!conversationId) return;
  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { ragState: createEmptyRagState() } },
  );
}

module.exports = {
  AWAITING_FOLLOW_UP,
  createEmptyRagState,
  normalizeRagState,
  isAwaitingFollowUp,
  formatStateForRouter,
  topicsFromRagState,
  hasCatalogThreadFromState,
  extractEntitiesFromMatches,
  buildUpdatedRagState,
  buildAckRagState,
  shouldClearRagState,
  shouldClearEntitiesOnly,
  loadRagState,
  saveRagState,
  clearRagState,
};
