/**
 * Multi-entity turn modes (turn-level, not per-entity).
 *
 * Used by Intent Router → Entity Resolution → Retrieval Plan Builder.
 */

const MULTI_ENTITY_MODES = {
  COMPARE: "compare",
  MULTI_ASK: "multi_ask",
  CHOOSE_FROM_LIST: "choose_from_list",
};

/**
 * @typedef {null | "compare" | "multi_ask" | "choose_from_list"} MultiEntityMode
 */

function isValidMultiEntityMode(mode) {
  if (!mode) return false;
  return Object.values(MULTI_ENTITY_MODES).includes(mode);
}

function normalizeMultiEntityMode(mode) {
  if (!mode) return null;
  const key = String(mode).toLowerCase().trim();
  if (key === "compare") return MULTI_ENTITY_MODES.COMPARE;
  if (key === "multi_ask" || key === "multi-entity" || key === "multi_entity") {
    return MULTI_ENTITY_MODES.MULTI_ASK;
  }

  if(key === "choose_from_list"){

    return MULTI_ENTITY_MODES.COMPARE; 
  }
  if (
  
    key === "choose" ||
    key === "recommend"
  ) {
    return MULTI_ENTITY_MODES.CHOOSE_FROM_LIST;
  }
  return null;
}

module.exports = {
  MULTI_ENTITY_MODES,
  isValidMultiEntityMode,
  normalizeMultiEntityMode,
};
