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
