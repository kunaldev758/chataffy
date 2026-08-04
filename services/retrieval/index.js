/**
 * Retrieval helpers — multi-entity pipeline + query preparation.
 *
 * Pipeline:
 *   Intent (multiEntityMode, rawEntities)
 *     → entityResolution
 *     → entityPlanBuilder
 *     → multiEntityRetrieval (per-entity hybrid + interleave)
 */

const { resolveAmbiguousPronouns } = require("./queryRewrite");
const {
  shouldRunHyDE,
  generateHyDEAndExpandQuery,
} = require("./hydeExpand");
const { prepareRetrievalQuery } = require("./prepareRetrievalQuery");
const {
  MULTI_ENTITY_MODES,
  normalizeMultiEntityMode,
} = require("./multiEntityModes");
const {
  enrichRoutingMultiEntity,
  resolveEntities,
  parseProductListFromAssistantText,
  isChooseFromListQuery,
} = require("./entityResolution");
const {
  buildEntityPlan,
  buildMultiEntityRetrievalPlan,
} = require("./entityPlanBuilder");
const {
  parseComparisonEntitiesRegex,
  parseMultiAskEntitiesRegex,
} = require("./multiEntityQuery");
const {
  runMultiEntityRetrieval,
  getMultiEntityRetrievalDefaults,
} = require("./multiEntityRetrieval");

module.exports = {
  resolveAmbiguousPronouns,
  shouldRunHyDE,
  generateHyDEAndExpandQuery,
  prepareRetrievalQuery,
  MULTI_ENTITY_MODES,
  normalizeMultiEntityMode,
  enrichRoutingMultiEntity,
  resolveEntities,
  parseProductListFromAssistantText,
  isChooseFromListQuery,
  buildEntityPlan,
  buildMultiEntityRetrievalPlan,
  parseComparisonEntitiesRegex,
  parseMultiAskEntitiesRegex,
  runMultiEntityRetrieval,
  getMultiEntityRetrievalDefaults,
};
