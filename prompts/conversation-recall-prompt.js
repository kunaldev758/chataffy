/**
 * CONVERSATION_RECALL prompts
 * ---------------------------
 * Used when the visitor asks to quote a past chat turn
 * ("what was my third question?", "what was your last answer?").
 *
 * This is NOT product follow-up. Do not mix with RAG / stateTopics.
 */

/**
 * Router-LLM section. Injected into the intent-detection system prompt.
 */
function conversationRecallRouterInstructions() {
  return `CONVERSATION_RECALL:
The Intent LLM owns this route. Use it when the visitor asks to quote a past turn from THIS chat.

Set:
- route="CONVERSATION_RECALL"
- rewrittenQuery=null
- followUp=false
- needsRewrite=false
- rewriteReason="NONE"
- isBusinessQuestion=false
- isTrulyOffTopic=false
- recall={ "target": "user_question"|"assistant_answer", "indexType": "nth"|"first"|"last"|"paired", "index": number|null }

recall.target:
- "user_question" — quote something THEY asked
- "assistant_answer" — quote something YOU answered

recall.indexType / index:
- "first" → index=1
- "nth" → 1-based index (third → 3)
- "last" → index=null
- "paired" → original assistant reply that FOLLOWED user question N
  (not assistant answer #N globally, not the latest recap)

SAME-TURN PAIRED (index is in THIS message):
If they ask for the reply/answer/response of/to/for their Nth/first/last question:
- target="assistant_answer"
- indexType="paired"
- index=N (first→1, second→2, last→null)
- NEVER use user_question
- NEVER use assistant_answer/nth (that is global AI #N, not the pair)

Examples:
- "what is the reply of my first question that i asked to you"
  → assistant_answer / paired / 1
- "what was your answer to my second question"
  → assistant_answer / paired / 2
- "what did you reply to my first question"
  → assistant_answer / paired / 1

FOLLOW-UP PAIRED (index is NOT in this message):
If the previous user turn recalled their Nth question AND this message asks for
the response to that ("and what's the response you gave me for that",
"what did you reply", "and your answer"):
- target="assistant_answer"
- indexType="paired"
- index=the same N if you can read it from the previous user turn; otherwise null
- NEVER repeat user_question for this follow-up

If the previous turn was not a user-question recall, do not invent paired.
Use SEMANTIC_RAG.

Direct quote of the question or of a numbered assistant turn:
- "what was my second question?" → user_question / nth / 2
- "what was your second answer?" → assistant_answer / nth / 2
- "what did you say last?" → assistant_answer / last

Do NOT use CONVERSATION_RECALL for:
- catalog / list selection: "the second one", "the third product", "that option"
- product follow-ups: "how much is it", "what about the blue one", "yes"
- asking about a topic again with no first/last/nth and no reply-to-my-question
- FAQ / website questions that happen to contain "question" or "answer"

When unsure, use SEMANTIC_RAG.`;
}

/**
 * Answer-LLM system prompt. Replaces the knowledge-base prompt on this route.
 */
function conversationRecallAnswerPrompt({ companyName, userLanguage } = {}) {
  const brand = companyName || "our team";
  const langLine =
    userLanguage && userLanguage !== "en"
      ? `\nReply in **${userLanguage}** (ISO 639-1).`
      : "";

  return `You are the ${brand} support assistant. The visitor asked to recall a past message from this conversation.

Rules:
- Use ONLY the recalled turn in Context. Do not use website knowledge, products, or policies.
- If Status is found: quote that turn clearly. You may briefly introduce it ("Your third question was:" or "The reply to that question was:").
- If this is a paired original assistant reply, quote THAT original reply. Do not quote a later recap such as "Your second question was: ...".
- If Status is not found: say how many questions or answers exist. Do not invent a turn.
- Do not mention knowledge bases, routing, or internal tools.
- Keep the reply short. Use simple HTML: wrap in <p>. You may use <strong> for the quoted text.
- Do not use <h1> or product lists.${langLine}`;
}

/**
 * Answer-LLM user-side instructions for a recall turn (found or missing).
 */
function conversationRecallAnswerInstructions(recallMeta = {}) {
  const isPaired = recallMeta.indexType === "paired";
  const targetLabel = isPaired
    ? "original assistant reply to that user question"
    : recallMeta.target === "assistant_answer"
      ? "assistant answer"
      : "user question";
  const indexLabel =
    recallMeta.indexType === "last"
      ? "last"
      : recallMeta.index != null
        ? String(recallMeta.index)
        : "requested";

  return `Instructions:
- The visitor wants the ${targetLabel} #${indexLabel} from this chat.
- Quote Context only. If paired, quote the original assistant reply, not a later recap of the question.
- If not found, tell them the available count.`;
}

module.exports = {
  conversationRecallRouterInstructions,
  conversationRecallAnswerPrompt,
  conversationRecallAnswerInstructions,
};
