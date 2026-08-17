const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseRecallIntent,
  resolveRecallReference,
  resolveRecallContract,
  buildRecallInventoryFromMessages,
  renderRecalledTurnHtml,
  RECALL_TARGETS,
} = require("./conversationRecallService");

const INVENTORY_8 = { userTurnCount: 8, assistantTurnCount: 8 };

function positionRecall(value, origin, { paired = false, target = "user_question" } = {}) {
  return {
    target,
    paired,
    reference: { type: "position", value, origin },
  };
}

function symbolicRecall(type, ordinal, { paired = false, target = "user_question" } = {}) {
  return {
    target,
    paired,
    reference: { type, ordinal: ordinal ?? null },
  };
}

test("symbolic first always resolves to question one, with optional pairing", () => {
  const questionOnly = resolveRecallContract(symbolicRecall("first"), {
    recallInventory: INVENTORY_8,
  });
  const withResponse = resolveRecallContract(
    symbolicRecall("first", null, { paired: true }),
    { recallInventory: INVENTORY_8 },
  );

  assert.deepEqual(questionOnly.recall, {
    target: RECALL_TARGETS.USER_QUESTION,
    indexType: "first",
    index: 1,
    displayReference: { type: "first" },
  });
  assert.deepEqual(withResponse.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 1,
    displayReference: { type: "first" },
  });
});

test("symbolic previous always resolves to the immediately preceding user turn", () => {
  const resolved = resolveRecallContract(
    symbolicRecall("previous", null, { paired: true }),
    { recallInventory: { userTurnCount: 4, assistantTurnCount: 4 } },
  );
  assert.deepEqual(resolved.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 4,
    displayReference: { type: "previous" },
  });
});

test("symbolic nth references resolve from start and end", () => {
  const fromStart = resolveRecallContract(
    symbolicRecall("nth_from_start", 2),
    { recallInventory: INVENTORY_8 },
  );
  const fromEnd = resolveRecallContract(
    symbolicRecall("nth_from_end", 3),
    { recallInventory: INVENTORY_8 },
  );

  assert.equal(fromStart.recall.index, 2);
  assert.equal(fromEnd.recall.index, 6);
});

test("third and fifth questions resolve to their absolute positions", () => {
  const third = resolveRecallContract(
    symbolicRecall("nth_from_start", 3),
    { recallInventory: INVENTORY_8 },
  );
  const fifth = resolveRecallContract(
    symbolicRecall("nth_from_start", 5),
    { recallInventory: INVENTORY_8 },
  );

  assert.equal(third.recall.index, 3);
  assert.equal(fifth.recall.index, 5);
});

test("named sixth question with its response remains paired to question six", () => {
  const resolved = resolveRecallContract(
    symbolicRecall("nth_from_start", 6, { paired: true }),
    { recallInventory: INVENTORY_8 },
  );

  assert.deepEqual(resolved.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 6,
    displayReference: { type: "nth_from_start", ordinal: 6 },
  });
});

test("last_recalled pairs the stored user question with its original answer", () => {
  const resolved = resolveRecallContract(
    symbolicRecall("last_recalled", null, { paired: true }),
    {
      recallInventory: INVENTORY_8,
      recallState: { userQuestionIndex: 2, anchorUserTurnCount: 8 },
    },
  );
  assert.deepEqual(resolved.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 2,
    displayReference: { type: "last_recalled" },
  });
});

test("last_recalled is rejected without a saved question or paired request", () => {
  assert.equal(
    resolveRecallContract(
      symbolicRecall("last_recalled", null, { paired: true }),
      { recallInventory: INVENTORY_8 },
    ).ok,
    false,
  );
  assert.equal(
    resolveRecallContract(symbolicRecall("last_recalled"), {
      recallInventory: INVENTORY_8,
      recallState: { userQuestionIndex: 2, anchorUserTurnCount: 8 },
    }).ok,
    false,
  );
});

test("position reference without origin is rejected so previous cannot become first", () => {
  assert.equal(
    parseRecallIntent({
      target: "user_question",
      paired: true,
      reference: { type: "position", value: 1 },
    }),
    null,
  );
});

test("previous/last from end is the last user turn, not question #1", () => {
  const resolved = resolveRecallContract(
    positionRecall(1, "end", { paired: true }),
    { recallInventory: INVENTORY_8 },
  );
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 8,
  });
});

test("parseRecallIntent keeps ordinal + origin and ignores absolute index", () => {
  const intent = parseRecallIntent({
    target: "user_question",
    paired: true,
    index: 6,
    reference: { type: "position", value: 3, origin: "end" },
  });
  assert.deepEqual(intent, {
    target: "user_question",
    paired: true,
    reference: { type: "position", value: 3, origin: "end" },
  });
});

test("resolveRecallReference maps start/end against total", () => {
  const start3 = { type: "position", value: 3, origin: "start" };
  const end3 = { type: "position", value: 3, origin: "end" };
  const last = { type: "position", value: 1, origin: "end" };
  assert.equal(resolveRecallReference(start3, 8), 3);
  assert.equal(resolveRecallReference(end3, 8), 6);
  assert.equal(resolveRecallReference(last, 8), 8);
  assert.equal(resolveRecallReference(end3, 2), null);
  assert.equal(resolveRecallReference(start3, 2), null);
});

test("8 user turns: first / third / last / second last / third last / last third", () => {
  const cases = [
    [positionRecall(1, "start"), 1, "first"],
    [positionRecall(3, "start"), 3, "nth"],
    [positionRecall(1, "end"), 8, "nth"],
    [positionRecall(2, "end"), 7, "nth"],
    [positionRecall(3, "end"), 6, "nth"],
  ];

  for (const [raw, index, indexType] of cases) {
    const resolved = resolveRecallContract(raw, { recallInventory: INVENTORY_8 });
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.recall, {
      target: RECALL_TARGETS.USER_QUESTION,
      indexType,
      index,
    });
  }

  const lastThird = resolveRecallContract(positionRecall(3, "end"), {
    recallInventory: INVENTORY_8,
  });
  assert.equal(lastThird.recall.index, 6);
});

test("paired true resolves user index then emits assistant_answer/paired", () => {
  const third = resolveRecallContract(positionRecall(3, "start", { paired: true }), {
    recallInventory: INVENTORY_8,
  });
  assert.deepEqual(third.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 3,
  });

  const thirdLastAnswer = resolveRecallContract(
    positionRecall(3, "end", { paired: true }),
    { recallInventory: INVENTORY_8 },
  );
  assert.deepEqual(thirdLastAnswer.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 6,
  });
});

test("global assistant answer uses assistant inventory, not paired", () => {
  const resolved = resolveRecallContract(
    positionRecall(3, "start", {
      paired: false,
      target: "assistant_answer",
    }),
    { recallInventory: INVENTORY_8 },
  );
  assert.deepEqual(resolved.recall, {
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "nth",
    index: 3,
  });
});

test("out of range recall is rejected", () => {
  assert.equal(
    resolveRecallContract(positionRecall(9, "start"), {
      recallInventory: INVENTORY_8,
    }).ok,
    false,
  );
  assert.equal(
    resolveRecallContract(positionRecall(9, "end"), {
      recallInventory: INVENTORY_8,
    }).ok,
    false,
  );
  assert.equal(
    resolveRecallContract(positionRecall(10, "start", { paired: true }), {
      recallInventory: INVENTORY_8,
    }).ok,
    false,
  );
});

test("legacy last maps to origin end, not an absolute index", () => {
  const resolved = resolveRecallContract(
    { target: "user_question", indexType: "last", index: null },
    { recallInventory: INVENTORY_8 },
  );
  assert.equal(resolved.recall.index, 8);
});

test("buildRecallInventoryFromMessages excludes the current visitor turn", () => {
  const messages = [
    { sender_type: "visitor", message: "hi" },
    { sender_type: "ai", message: "hello" },
    { sender_type: "visitor", message: "give me 10 mm lashes" },
    { sender_type: "ai", message: "here are lashes" },
    { sender_type: "visitor", message: "what was my last third question" },
  ];
  const inventory = buildRecallInventoryFromMessages(
    messages,
    "what was my last third question",
  );
  assert.equal(inventory.userTurnCount, 2);
  assert.equal(inventory.assistantTurnCount, 2);
});

test("recall requests remain numbered as normal visitor questions", () => {
  const messages = [
    { sender_type: "visitor", message: "What is the capital of Japan?" },
    { sender_type: "ai", message: "Tokyo." },
    { sender_type: "visitor", message: "What is Japan's population?" },
    { sender_type: "ai", message: "About 123 million." },
    {
      sender_type: "visitor",
      message: "What was my second question and your response?",
    },
    { sender_type: "ai", message: "Your second question was..." },
    {
      sender_type: "visitor",
      message: "What was my previous question and your response?",
    },
  ];
  const inventory = buildRecallInventoryFromMessages(
    messages,
    "What was my previous question and your response?",
  );
  assert.deepEqual(inventory, {
    userTurnCount: 3,
    assistantTurnCount: 3,
  });
});

test("renderRecalledTurnHtml quotes full question and full original answer for paired", () => {
  const html = renderRecalledTurnHtml({
    found: true,
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 2,
    requestedIndex: 2,
    total: 8,
    questionText: "give me 10 mm lashes",
    text: "<p>Here are our 10mm lashes with prices and options.</p><ul><li>Classic 10mm</li></ul>",
  });
  assert.match(html, /Your question #2 was/);
  assert.match(html, /give me 10 mm lashes/);
  assert.match(html, /My response was/);
  assert.match(html, /Classic 10mm/);
  assert.match(html, /prices and options/);
});

test("renderRecalledTurnHtml uses natural labels for symbolic references", () => {
  const previous = renderRecalledTurnHtml({
    found: true,
    target: RECALL_TARGETS.USER_QUESTION,
    indexType: "first",
    index: 1,
    requestedIndex: 1,
    total: 1,
    text: "give me 20 mm lashes",
    displayReference: { type: "previous" },
  });
  const pairedFirst = renderRecalledTurnHtml({
    found: true,
    target: RECALL_TARGETS.ASSISTANT_ANSWER,
    indexType: "paired",
    index: 1,
    requestedIndex: 1,
    total: 3,
    questionText: "give me 20 mm lashes",
    text: "Here are the available options.",
    displayReference: { type: "first" },
  });

  assert.match(previous, /Your previous question was/);
  assert.doesNotMatch(previous, /question #1/);
  assert.match(pairedFirst, /Your first question was/);
  assert.match(pairedFirst, /My response was/);
});

test("renderRecalledTurnHtml does not invent a turn when missing", () => {
  const html = renderRecalledTurnHtml({
    found: false,
    target: RECALL_TARGETS.USER_QUESTION,
    indexType: "nth",
    index: 9,
    requestedIndex: 9,
    total: 8,
    text: null,
  });
  assert.match(html, /could not find/);
  assert.match(html, /8 questions/);
});
