/**
 * Entity Resolution Layer
 * -----------------------
 * Turns intent outputs (multiEntityMode + rawEntities) into a normalized
 * entity name list ready for retrieval plan building.
 *
 * Responsibilities:
 *   • Resolve names from the query when present
 *   • For choose_from_list: history / last assistant list / ragState
 *   • Normalize, dedupe, cap count (2–3)
 *
 * No LLM calls — rules + structured history parsing only.
 */

const {
  MULTI_ENTITY_MODES,
  normalizeMultiEntityMode,
} = require("./multiEntityModes");
const {
  parseComparisonEntitiesRegex,
  parseMultiAskEntitiesRegex,
  cleanEntity,
  dedupeEntities,
  isUsableEntity,
  getMaxEntities,
  isMultiEntityRetrievalEnabled,
} = require("./multiEntityQuery");
const { stripHtmlPreserveLinks } = require("./queryRewrite");

/**
 * Detect choose-from-list intent from short follow-ups.
 * @param {string} query
 * @returns {boolean}
 */
function isChooseFromListQuery(query) {
  const q = (query || "").trim();
  if (!q) return false;
  return (
    /\b(which one|which should i|should i choose|help me choose|what should i (?:pick|choose|get)|recommend(?:ation)?|which is best for me|which do you recommend|which would you (?:pick|recommend)|pick for me|choose for me)\b/i.test(
      q,
    ) ||
    /^(which|what) one\b/i.test(q)
  );
}

/**
 * Parse product names from an assistant list/catalog answer.
 * Handles lines like:
 *   "Playmaker Board - $432.00 to $864.00"
 *   "Courtside Playmaker Board 12x16 - $50.00"
 *   HTML <p> / <li> wrapped catalog replies
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseProductListFromAssistantText(text) {
  const withBreaks = String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n");

  const plain = stripHtmlPreserveLinks(withBreaks);
  if (!plain) return [];

  const entities = [];
  const seen = new Set();

  const tryAdd = (rawName) => {
    const name = cleanEntity(rawName);
    if (!isUsableEntity(name) || name.length < 3) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(name);
  };

  // Structured HTML is flattened by stripHtmlPreserveLinks, so scan labeled
  // Name fields globally before applying the legacy line/price patterns.
  const labeledNamePattern =
    /(?:^|\s)\*{0,2}(?:product\s+)?name:\*{0,2}\s*(.+?)(?=\s+\*{0,2}(?:price|link):|$)/gi;
  for (const match of plain.matchAll(labeledNamePattern)) {
    tryAdd(match[1]);
  }

  if (entities.length >= 2) {
    return entities.slice(0, getMaxEntities());
  }

  // Global scan — works when HTML collapsed newlines or list is inline.
  const pricePattern =
    /([A-Za-z0-9][A-Za-z0-9\s.'″"x×\-]{2,90}?)\s+[-–—]\s+\$?\d[\d,]*(?:\.\d{2})?(?:\s+to\s+\$?\d[\d,]*(?:\.\d{2})?)?/gi;
  for (const match of plain.matchAll(pricePattern)) {
    tryAdd(match[1]);
  }

  if (entities.length >= 2) {
    return entities.slice(0, getMaxEntities());
  }

  const lines = plain.split(/\n+/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.length < 3) continue;

    // Skip intro/catalog headers
    if (
      /^(here are|below are|we offer|pricing|all the|following)/i.test(line) &&
      !/\$\d/.test(line)
    ) {
      continue;
    }

    line = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");

    // Structured product replies use a labeled Name field on its own line.
    const labeledName = line.match(
      /^\*{0,2}(?:product\s+)?name:\*{0,2}\s*(.{2,90})$/i,
    );
    if (labeledName) {
      tryAdd(labeledName[1]);
      continue;
    }

    const priceSplit = line.match(
      /^(.+?)\s+[-–—]\s+\$?\d[\d,]*(?:\.\d{2})?(?:\s+to\s+\$?\d[\d,]*(?:\.\d{2})?)?/,
    );
    if (priceSplit) {
      tryAdd(priceSplit[1]);
      continue;
    }

    const boldOnly = line.match(/^\*\*([^*]{2,80})\*\*/);
    if (boldOnly) {
      tryAdd(boldOnly[1]);
    }
  }

  return dedupeEntities(entities).slice(0, getMaxEntities());
}

/**
 * Extract entities from recent assistant messages (newest first).
 * @param {Array<object>} chatHistory - ChatMessage docs
 * @returns {string[]}
 */
function resolveEntitiesFromChatHistory(chatHistory = []) {
  const messages = [...(chatHistory || [])].reverse();
  for (const msg of messages) {
    const sender = msg.sender_type || msg.role || "";
    const isAssistant =
      sender === "ai" ||
      sender === "bot" ||
      sender === "assistant";
    if (!isAssistant) continue;

    const content = msg.message || msg.content || "";
    const parsed = parseProductListFromAssistantText(content);
    if (parsed.length >= 2) {
      console.log(
        `[entityResolution] History list: ${parsed.join(" | ")}`,
      );
      return parsed;
    }
  }
  return [];
}

/**
 * Resolve from ragState.listedProducts (persisted from prior list turn).
 * @param {object} ragState
 * @returns {string[]}
 */
function resolveEntitiesFromRagState(ragState) {
  const listed = ragState?.listedProducts;
  if (!Array.isArray(listed) || listed.length < 2) return [];
  return dedupeEntities(
    listed.map(cleanEntity).filter(isUsableEntity),
  ).slice(0, getMaxEntities());
}

/**
 * Resolve from prior retrieval match titles (fallback).
 * @param {Array<object>} lastMatches
 * @returns {string[]}
 */
function resolveEntitiesFromMatches(lastMatches = []) {
  const titles = [];
  for (const m of lastMatches || []) {
    const title = String(m?.payload?.title || "").trim();
    if (title && title.length >= 3 && title.length <= 120) {
      titles.push(cleanEntity(title));
    }
  }
  return dedupeEntities(titles.filter(isUsableEntity)).slice(0, getMaxEntities());
}

/**
 * Rule-based multiEntityMode + rawEntities when router did not set them.
 * @param {string} query
 * @returns {{ multiEntityMode: string|null, rawEntities: string[] }}
 */
function detectMultiEntityFromRules(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    return { multiEntityMode: null, rawEntities: [] };
  }

  if (isChooseFromListQuery(trimmed)) {
    return {
      multiEntityMode: MULTI_ENTITY_MODES.CHOOSE_FROM_LIST,
      rawEntities: [],
    };
  }

  const comparison = parseComparisonEntitiesRegex(trimmed);
  if (comparison.isComparison && comparison.entities.length >= 2) {
    return {
      multiEntityMode: MULTI_ENTITY_MODES.COMPARE,
      rawEntities: comparison.entities,
    };
  }

  const multiAsk = parseMultiAskEntitiesRegex(trimmed);
  if (multiAsk.length >= 2) {
    return {
      multiEntityMode: MULTI_ENTITY_MODES.MULTI_ASK,
      rawEntities: multiAsk,
    };
  }

  return { multiEntityMode: null, rawEntities: [] };
}

/**
 * Merge router output with rule fallback for multi-entity fields.
 *
 * @param {object} routing - from routeQuery
 * @param {string} query
 * @returns {object} routing with multiEntityMode + rawEntities
 */
function enrichRoutingMultiEntity(routing = {}, query = "") {
  // Category/nav lists may contain "and" but remain one PAGE_LINKS request.
  if (routing.subIntent === "PAGE_LINKS") {
    return {
      ...routing,
      multiEntityMode: null,
      rawEntities: [],
    };
  }

  const ruleHit = detectMultiEntityFromRules(query);
  const mode =
    normalizeMultiEntityMode(routing.multiEntityMode) ||
    ruleHit.multiEntityMode;

  let rawEntities = Array.isArray(routing.rawEntities)
    ? routing.rawEntities.map(cleanEntity).filter(isUsableEntity)
    : [];

  if (rawEntities.length === 0 && ruleHit.rawEntities.length > 0) {
    rawEntities = ruleHit.rawEntities;
  }

  return {
    ...routing,
    multiEntityMode: mode,
    rawEntities: dedupeEntities(rawEntities).slice(0, getMaxEntities()),
  };
}

/**
 * Full entity resolution for the retrieval pipeline.
 *
 * @param {object} params
 * @param {string|null} params.multiEntityMode
 * @param {string[]} [params.rawEntities]
 * @param {string} params.query
 * @param {Array<object>} [params.chatHistory]
 * @param {object} [params.ragState]
 * @param {Array<object>} [params.lastMatches]
 * @returns {{
 *   multiEntityMode: string|null,
 *   entities: string[],
 *   source: string,
 *   shouldUseMultiRetrieval: boolean,
 * }}
 */
function resolveEntities({
  multiEntityMode = null,
  rawEntities = [],
  query = "",
  chatHistory = [],
  ragState = null,
  lastMatches = [],
} = {}) {
  // if (!isMultiEntityRetrievalEnabled()) {
  //   return {
  //     multiEntityMode: null,
  //     entities: [],
  //     source: "disabled",
  //     shouldUseMultiRetrieval: false,
  //   };
  // }

  const mode = normalizeMultiEntityMode(multiEntityMode);

  console.log("check multi entity mode : ",mode);
  let entities = dedupeEntities(
    (rawEntities || []).map(cleanEntity).filter(isUsableEntity),
  );
  let source = entities.length >= 2 ? "router" : "none";

  // Query regex fallback when router gave mode but no names
  if (entities.length < 2 && mode) {
    const fromQuery = detectMultiEntityFromRules(query);
    if (fromQuery.rawEntities.length >= 2) {
      entities = fromQuery.rawEntities;
      source = "query_regex";
    }
  }

  // choose_from_list: fill from history → ragState → last matches
  if (
    entities.length < 2 &&
    mode === MULTI_ENTITY_MODES.CHOOSE_FROM_LIST
  ) {
    const fromHistory = resolveEntitiesFromChatHistory(chatHistory);
    if (fromHistory.length >= 2) {
      entities = fromHistory;
      source = "history_list";
    } else {
      const fromState = resolveEntitiesFromRagState(ragState);
      if (fromState.length >= 2) {
        entities = fromState;
        source = "rag_state";
      } else {
        const fromMatches = resolveEntitiesFromMatches(lastMatches);
        if (fromMatches.length >= 2) {
          entities = fromMatches;
          source = "last_matches";
        }
      }
    }
  }

  entities = entities.slice(0, getMaxEntities());

  const shouldUseMultiRetrieval =
    Boolean(mode) && entities.length >= 2;

  console.log(
    `[entityResolution] mode=${mode || "none"} entities=[${entities.join(" | ")}] ` +
      `source=${source} multi=${shouldUseMultiRetrieval}`,
  );

  return {
    multiEntityMode: mode,
    entities,
    source,
    shouldUseMultiRetrieval,
  };
}

module.exports = {
  isChooseFromListQuery,
  parseProductListFromAssistantText,
  resolveEntitiesFromChatHistory,
  resolveEntitiesFromRagState,
  detectMultiEntityFromRules,
  enrichRoutingMultiEntity,
  resolveEntities,
};
