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
- recall={
    "target": "user_question"|"assistant_answer",
    "paired": boolean,
    "reference": {
      "type": "position"|"relative"|"semantic",
      "value": number|null,
      "origin": "start"|"end"|null
    }
  }

Do NOT emit an absolute conversation index. reference.value is the ordinal the user asked for (third → 3, last → 1 from the end). The application resolves it using Chat inventory.

reference:
- Always set origin for type="position". Never emit value without origin.
- "my Nth question" → type="position", value=N, origin="start"
- "my last / previous / prior question" → type="position", value=1, origin="end"
  (previous is NOT the first question)
- "Nth last" / "last Nth" / "N questions ago" → type="position", value=N, origin="end"
  ("third last" and "last third" are the same: value=3, origin="end")
- Follow-up with no ordinal ("and your response to that") → type="semantic", value=null, origin=null

target / paired:
- Quote what THEY asked → target="user_question", paired=false
- Quote YOUR answer TO THEIR Nth question, or the question AND your response
  → target="user_question", paired=true
- Quote YOUR Nth answer globally ("what was your third answer?")
  → target="assistant_answer", paired=false
Never use assistant_answer/nth for "your answer to my Nth question". That is paired on the user turn.

Examples:
- "what was my third question?"
  → user_question, paired=false, position 3 from start
- "what was my last question?"
  → user_question, paired=false, position 1 from end
- "what is my previous question with its response"
  → user_question, paired=true, position 1 from end
- "what was my previous question?"
  → user_question, paired=false, position 1 from end
- "what was my third last question?"
  → user_question, paired=false, position 3 from end
- "what was my last third question?"
  → user_question, paired=false, position 3 from end
- "give me the response to my third question"
  → user_question, paired=true, position 3 from start
- "what did you answer to my third last question?"
  → user_question, paired=true, position 3 from end
- "show me my third question and your response"
  → user_question, paired=true, position 3 from start
- "what was your third answer?"
  → assistant_answer, paired=false, position 3 from start
- "what did you say last?"
  → assistant_answer, paired=false, position 1 from end
- "give me the answer from three questions ago"
  → user_question, paired=true, position 3 from end

Chat inventory (user_turns / assistant_turns) is the full conversation, not the recent snippet.
If the requested ordinal is outside that inventory, set recall=null and use SEMANTIC_RAG.

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
