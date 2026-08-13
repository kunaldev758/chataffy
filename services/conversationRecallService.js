/**
 * CONVERSATION_RECALL
 * -------------------
 * Quote a numbered past user question or assistant answer from ChatMessage.
 *
 * Independent of ragState / stateTopics. Numbering is 1-based from the start
 * of this conversation, excluding the current visitor message (already saved
 * before getAnswer runs).
 */

const ChatMessage = require("../models/ChatMessage");
const { decode } = require("html-entities");

const RECALL_TARGETS = {
  USER_QUESTION: "user_question",
  ASSISTANT_ANSWER: "assistant_answer",
};

const USER_SENDER_TYPES = ["visitor"];
const ASSISTANT_SENDER_TYPES = ["ai", "bot"];

const WORD_ORDINALS = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

const LAST_TOKENS = new Set(["last", "previous", "latest", "just"]);

const ORDINAL_CAPTURE =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|previous|latest|\\d+(?:st|nd|rd|th)?";

function stripHtml(text) {
  return decode(String(text || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestionText(text) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/[?!.,'"“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOrdinalToken(token) {
  if (!token) return null;
  const t = String(token).toLowerCase().trim();
  if (LAST_TOKENS.has(t)) {
    return { indexType: "last", index: null };
  }
  if (WORD_ORDINALS[t]) {
    const index = WORD_ORDINALS[t];
    return { indexType: index === 1 ? "first" : "nth", index };
  }
  const numeric = t.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (numeric) {
    const index = Number(numeric[1]);
    if (Number.isInteger(index) && index >= 1 && index <= 200) {
      return { indexType: index === 1 ? "first" : "nth", index };
    }
  }
  return null;
}

/**
 * Normalize LLM / rules recall payload. Returns null when incomplete.
 */
function normalizeRecall(raw) {
  if (!raw || typeof raw !== "object") return null;

  const target = String(raw.target || "").toLowerCase().trim();
  if (
    target !== RECALL_TARGETS.USER_QUESTION &&
    target !== RECALL_TARGETS.ASSISTANT_ANSWER
  ) {
    return null;
  }

  const indexType = String(raw.indexType || "").toLowerCase().trim();
  const parsedIndex =
    raw.index === null || raw.index === undefined || raw.index === ""
      ? null
      : Number(raw.index);

  if (indexType === "first") {
    return { target, indexType: "first", index: 1 };
  }
  if (indexType === "last") {
    return { target, indexType: "last", index: null };
  }
  // Paired = original AI reply that followed user question N (not AI #N, not latest).
  if (indexType === "paired") {
    if (target !== RECALL_TARGETS.ASSISTANT_ANSWER) return null;
    if (parsedIndex === null) {
      return { target, indexType: "paired", index: null };
    }
    if (!Number.isInteger(parsedIndex) || parsedIndex < 1 || parsedIndex > 200) {
      return null;
    }
    return { target, indexType: "paired", index: parsedIndex };
  }
  if (indexType === "nth" || indexType === "") {
    if (!Number.isInteger(parsedIndex) || parsedIndex < 1 || parsedIndex > 200) {
      return null;
    }
    return {
      target,
      indexType: parsedIndex === 1 ? "first" : "nth",
      index: parsedIndex,
    };
  }

  return null;
}

function buildRecall(target, ordinalOrNumber) {
  const parsed =
    typeof ordinalOrNumber === "object" && ordinalOrNumber?.indexType
      ? ordinalOrNumber
      : parseOrdinalToken(ordinalOrNumber);
  if (!parsed) return null;
  return normalizeRecall({ target, ...parsed });
}

function isVisitorMessage(msg) {
  const sender = msg?.sender_type || msg?.role || "";
  return sender === "visitor" || sender === "user";
}

function isAssistantMessage(msg) {
  const sender = msg?.sender_type || msg?.role || "";
  return sender === "ai" || sender === "bot" || sender === "assistant";
}

/**
 * Direct numbered/first/last recall. Catalog picks ("the second one") must not match.
 */
function detectDirectConversationRecall(question) {
  const raw = String(question || "").trim();
  if (!raw || raw.length > 220) return null;

  const text = normalizeQuestionText(raw);
  if (!text) return null;

  // "the second one / third product" is catalog selection, not transcript recall.
  if (
    /\b(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(?:one|product|item|option|choice|pair|color|size|collection)\b/.test(
      text,
    )
  ) {
    return null;
  }

  const ordinal = `(${ORDINAL_CAPTURE})`;
  const patterns = [
    {
      re: new RegExp(
        `\\b(?:what|which)\\s+(?:was|is|were)\\s+my\\s+${ordinal}\\s+(?:question|query|message)\\b`,
      ),
      target: RECALL_TARGETS.USER_QUESTION,
      group: 1,
    },
    {
      re: new RegExp(
        `\\b(?:what|which)\\s+(?:was|is|were)\\s+your\\s+${ordinal}\\s+(?:answer|reply|response)\\b`,
      ),
      target: RECALL_TARGETS.ASSISTANT_ANSWER,
      group: 1,
    },
    {
      re: new RegExp(`\\bwhat\\s+did\\s+i\\s+(?:ask|say)\\s+${ordinal}\\b`),
      target: RECALL_TARGETS.USER_QUESTION,
      group: 1,
    },
    {
      re: new RegExp(
        `\\bwhat\\s+did\\s+you\\s+(?:say|answer|reply|tell\\s+me)\\s+${ordinal}\\b`,
      ),
      target: RECALL_TARGETS.ASSISTANT_ANSWER,
      group: 1,
    },
    {
      re: new RegExp(
        `\\b(?:repeat|remind\\s+me(?:\\s+of)?|show\\s+me)\\s+my\\s+${ordinal}\\s+(?:question|query)\\b`,
      ),
      target: RECALL_TARGETS.USER_QUESTION,
      group: 1,
    },
    {
      re: new RegExp(
        `\\b(?:repeat|remind\\s+me(?:\\s+of)?|show\\s+me)\\s+your\\s+${ordinal}\\s+(?:answer|reply)\\b`,
      ),
      target: RECALL_TARGETS.ASSISTANT_ANSWER,
      group: 1,
    },
    {
      re: /\bwhat\s+was\s+my\s+(?:question|query)\s+(?:number\s+)?(\d+)\b/,
      target: RECALL_TARGETS.USER_QUESTION,
      group: 1,
    },
    {
      re: /\bwhat\s+was\s+your\s+(?:answer|reply)\s+(?:number\s+)?(\d+)\b/,
      target: RECALL_TARGETS.ASSISTANT_ANSWER,
      group: 1,
    },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const recall = buildRecall(pattern.target, match[pattern.group]);
    if (recall) return recall;
  }

  if (/\bwhat\s+(?:was|is)\s+the\s+last\s+thing\s+i\s+(?:asked|said)\b/.test(text)) {
    return buildRecall(RECALL_TARGETS.USER_QUESTION, "last");
  }
  if (
    /\bwhat\s+(?:was|is)\s+the\s+last\s+thing\s+you\s+(?:said|answered|replied)\b/.test(
      text,
    )
  ) {
    return buildRecall(RECALL_TARGETS.ASSISTANT_ANSWER, "last");
  }

  return null;
}

/**
 * Anaphoric "your answer/response to that" — not "what was your second answer".
 */
function isPairedRecallFollowUp(question) {
  if (detectDirectConversationRecall(question)) return false;

  const text = normalizeQuestionText(question);
  if (!text || text.length > 220) return false;

  return (
    /\bwhat(?:s|'s| is| was)\s+(?:the\s+)?(?:response|reply|answer)\b/.test(text) ||
    /\band\s+(?:what(?:s|'s| is| was)\s+)?(?:the\s+)?(?:response|reply|answer)\b/.test(
      text,
    ) ||
    /\bwhat\s+did\s+you\s+(?:reply|answer|say)(?:\s+in\s+response)?\b/.test(text) ||
    /\b(?:response|reply|answer)\s+you\s+gave\b/.test(text) ||
    /\b(?:your|the)\s+(?:response|reply|answer)\s+(?:to|for)\s+(?:that|it|this)\b/.test(
      text,
    ) ||
    /\band\s+your\s+(?:answer|reply|response)\b/.test(text) ||
    /\bsay\s+in\s+response\b/.test(text)
  );
}

function visitorTurnsFromMessages(chatMessages) {
  return (chatMessages || []).filter(
    (msg) => isVisitorMessage(msg) && stripHtml(msg.message),
  );
}

/**
 * Last visitor turn before the in-flight question. Used to recover the
 * previous CONVERSATION_RECALL (no ragState).
 */
function getPreviousVisitorMessage(chatMessages, currentQuestion) {
  const visitors = excludeCurrentUserTurn(
    visitorTurnsFromMessages(chatMessages),
    currentQuestion,
  );
  if (!visitors.length) return null;
  return visitors[visitors.length - 1];
}

function resolvePairedIndex(previousRecall) {
  if (!previousRecall || previousRecall.target !== RECALL_TARGETS.USER_QUESTION) {
    return null;
  }
  if (
    previousRecall.indexType === "nth" ||
    previousRecall.indexType === "first"
  ) {
    return previousRecall.index;
  }
  // "last" is resolved from full ChatMessage history at fetch time.
  return null;
}

/**
 * Fill paired index from the previous visitor turn only (not the current query).
 * Used when the Intent LLM returns paired without an index ("the response for that").
 */
function fillPairedFromPreviousVisitor(chatMessages, currentQuestion) {
  const previousVisitor = getPreviousVisitorMessage(chatMessages, currentQuestion);
  if (!previousVisitor) return null;

  const previousRecall = detectDirectConversationRecall(previousVisitor.message);
  if (!previousRecall || previousRecall.target !== RECALL_TARGETS.USER_QUESTION) {
    return null;
  }

  const index = resolvePairedIndex(previousRecall);
  return normalizeRecall({
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index,
  });
}

/**
 * Validate / complete the Intent LLM recall contract.
 * Same-turn paired with an index is kept. Paired without index is filled
 * from the previous user-question recall. Incomplete contracts are rejected.
 */
function resolveRecallContract(rawRecall, { chatMessages = [], currentQuestion = "" } = {}) {
  const recall = normalizeRecall(rawRecall);
  if (!recall) return { ok: false, recall: null };

  if (recall.indexType !== "paired") {
    return { ok: true, recall };
  }

  if (Number.isInteger(recall.index) && recall.index >= 1) {
    return { ok: true, recall };
  }

  const filled = fillPairedFromPreviousVisitor(chatMessages, currentQuestion);
  if (filled) return { ok: true, recall: filled };

  return { ok: false, recall: null };
}

/**
 * If the previous visitor turn recalled a user question, map "the response
 * for that" onto assistant_answer / paired / that index.
 */
function buildPairedRecallFromHistory(question, chatMessages = []) {
  if (!isPairedRecallFollowUp(question)) return null;
  return fillPairedFromPreviousVisitor(chatMessages, question);
}

/**
 * Direct recall first, then paired follow-up from the previous visitor turn.
 */
function detectConversationRecall(question, { chatMessages = [] } = {}) {
  const direct = detectDirectConversationRecall(question);
  if (direct) return direct;
  return buildPairedRecallFromHistory(question, chatMessages);
}

/**
 * Drop the in-flight visitor message so "third question" does not count
 * the recall ask itself.
 */
function excludeCurrentUserTurn(turns, currentQuestion) {
  if (!turns.length) return turns;
  const current = normalizeQuestionText(currentQuestion);
  if (!current) return turns;

  const last = turns[turns.length - 1];
  if (normalizeQuestionText(last.message) === current) {
    return turns.slice(0, -1);
  }
  return turns;
}

/**
 * Original AI reply that followed visitor question N.
 * Not assistant #N and not the latest recap ("Your second question was:").
 */
async function fetchPairedAssistantReply({
  conversationId,
  index,
  currentQuestion = "",
}) {
  const empty = {
    found: false,
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: index ?? null,
    requestedIndex: index ?? null,
    total: 0,
    text: null,
  };

  const messages = await ChatMessage.find({
    conversation_id: conversationId,
    sender_type: { $in: [...USER_SENDER_TYPES, ...ASSISTANT_SENDER_TYPES] },
  })
    .sort({ createdAt: 1 })
    .select("message sender_type createdAt")
    .lean();

  const all = (messages || []).filter((msg) => stripHtml(msg.message));
  let visitors = all.filter((msg) => isVisitorMessage(msg));
  visitors = excludeCurrentUserTurn(visitors, currentQuestion);

  let userTurn = null;
  let requestedIndex = index;
  if (Number.isInteger(index) && index >= 1) {
    userTurn = visitors[index - 1] || null;
  } else if (visitors.length >= 2) {
    // Previous recall was "my last question" → question before that ask.
    userTurn = visitors[visitors.length - 2];
    requestedIndex = visitors.length - 1;
  }

  if (!userTurn) {
    return { ...empty, total: visitors.length, requestedIndex };
  }

  const userTime = new Date(userTurn.createdAt).getTime();
  const reply = all.find(
    (msg) =>
      isAssistantMessage(msg) && new Date(msg.createdAt).getTime() > userTime,
  );

  if (!reply) {
    return {
      ...empty,
      total: visitors.length,
      requestedIndex:
        Number.isInteger(index) && index >= 1 ? index : requestedIndex,
    };
  }

  return {
    found: true,
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: Number.isInteger(index) && index >= 1 ? index : requestedIndex,
    requestedIndex: Number.isInteger(index) && index >= 1 ? index : requestedIndex,
    total: visitors.length,
    text: stripHtml(reply.message),
  };
}

/**
 * Fetch the requested turn. Does not use CHAT_HISTORY_LIMIT.
 */
async function fetchRecalledTurn({
  conversationId,
  recall,
  currentQuestion = "",
} = {}) {
  const normalized = normalizeRecall(recall);
  if (!conversationId || !normalized) {
    return {
      found: false,
      target: recall?.target || RECALL_TARGETS.USER_QUESTION,
      indexType: recall?.indexType || "nth",
      index: recall?.index ?? null,
      requestedIndex: recall?.index ?? null,
      total: 0,
      text: null,
    };
  }

  if (normalized.indexType === "paired") {
    return fetchPairedAssistantReply({
      conversationId,
      index: normalized.index,
      currentQuestion,
    });
  }

  const senderTypes =
    normalized.target === RECALL_TARGETS.ASSISTANT_ANSWER
      ? ASSISTANT_SENDER_TYPES
      : USER_SENDER_TYPES;

  const messages = await ChatMessage.find({
    conversation_id: conversationId,
    sender_type: { $in: senderTypes },
  })
    .sort({ createdAt: 1 })
    .select("message sender_type createdAt")
    .lean();

  let turns = (messages || []).filter((msg) => stripHtml(msg.message));
  if (normalized.target === RECALL_TARGETS.USER_QUESTION) {
    turns = excludeCurrentUserTurn(turns, currentQuestion);
  }

  const total = turns.length;
  const requestedIndex =
    normalized.indexType === "last" ? total : normalized.index;
  const inRange =
    Number.isInteger(requestedIndex) &&
    requestedIndex >= 1 &&
    requestedIndex <= total;

  if (!inRange) {
    return {
      found: false,
      target: normalized.target,
      indexType: normalized.indexType,
      index: normalized.index,
      requestedIndex,
      total,
      text: null,
    };
  }

  return {
    found: true,
    target: normalized.target,
    indexType: normalized.indexType,
    index: requestedIndex,
    requestedIndex,
    total,
    text: stripHtml(turns[requestedIndex - 1].message),
  };
}

function buildRecallContext(fetched) {
  const isPaired = fetched.indexType === "paired";
  const role = isPaired
    ? "original assistant reply to user question"
    : fetched.target === RECALL_TARGETS.ASSISTANT_ANSWER
      ? "assistant answer"
      : "user question";
  const indexLabel =
    fetched.indexType === "last" && fetched.found
      ? `last (${fetched.index} of ${fetched.total})`
      : `#${fetched.requestedIndex || fetched.index || "?"}`;

  if (!fetched.found) {
    return `Status: not found
Requested: ${role} ${indexLabel}
Available user questions: ${fetched.total}
Text: (none)`;
  }

  return `Status: found
Requested: ${role} ${indexLabel}
Quote the original turn below. If this is a paired reply, do not quote a later recap of the question.
Text:
${fetched.text}`;
}

module.exports = {
  RECALL_TARGETS,
  normalizeRecall,
  detectDirectConversationRecall,
  detectConversationRecall,
  isPairedRecallFollowUp,
  buildPairedRecallFromHistory,
  fetchRecalledTurn,
  buildRecallContext,
  fillPairedFromPreviousVisitor,
  resolveRecallContract,
};
