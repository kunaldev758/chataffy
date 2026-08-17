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
      "type": "first"|"previous"|"nth_from_start"|"nth_from_end"|"last_recalled",
      "ordinal": number|null
    }
  }

Extract the reference ONLY from the current User message. Never copy a number
from Recent conversation, Conversation state, Last recalled turn, or Chat inventory.
Chat inventory only validates that the requested turn exists.

reference:
- first / earliest / original → {"type":"first","ordinal":null}
- previous / last / prior / latest → {"type":"previous","ordinal":null}
- Nth question/answer → {"type":"nth_from_start","ordinal":N}
- Nth-last / last Nth / N ago → {"type":"nth_from_end","ordinal":N}
- response to it/that after a recalled user question
  → {"type":"last_recalled","ordinal":null}

target / paired:
- Quote what THEY asked → target="user_question", paired=false
- Quote YOUR answer TO THEIR Nth question, or the question AND your response
  → target="user_question", paired=true
- Quote YOUR Nth answer globally ("what was your third answer?")
  → target="assistant_answer", paired=false
Never use assistant_answer/nth for "your answer to my Nth question". That is paired on the user turn.
If the current message names a question reference AND asks for its response,
paired=true and "it/that" means that same question. Keep the current reference.
Use last_recalled only when the current message has no first/previous/Nth reference.

All visitor messages count as user questions, including earlier recall requests.
"Previous question" means the immediately preceding visitor message; never skip
a recall request to search for an earlier business question.

Critical example:
Recent Assistant: "Your question #4 was: give me 16 mm lashes"
Current User: "what is my previous question and your response?"
→ target=user_question, paired=true, reference={"type":"previous","ordinal":null}
The #4 belongs to history and MUST NOT become the reference ordinal.

"what was my first question and your response?" even when recent history
contains "previous question"
→ target=user_question, paired=true, reference={"type":"first","ordinal":null}

"what was my second question and your response?"
→ target=user_question, paired=true, reference={"type":"nth_from_start","ordinal":2}

"what was my third-last question?"
→ target=user_question, paired=false, reference={"type":"nth_from_end","ordinal":3}

"what was your response to it?" with Last recalled turn present
→ target=user_question, paired=true, reference={"type":"last_recalled","ordinal":null}

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
