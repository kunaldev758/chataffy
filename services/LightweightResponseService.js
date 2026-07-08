const { normalizeLanguageCode, resolveUserLanguage } = require("../utils/websiteLanguage");

const GREETING_LANGUAGE_BY_PHRASE = {
  hi: "en",
  hello: "en",
  hey: "en",
  greetings: "en",
  "good morning": "en",
  "good afternoon": "en",
  "good evening": "en",
  "good night": "en",
  howdy: "en",
  sup: "en",
  "what's up": "en",
  "hey there": "en",
  hola: "es",
  "buenos días": "es",
  "buenas tardes": "es",
  "buenas noches": "es",
  bonjour: "fr",
  salut: "fr",
  ciao: "it",
  hallo: "de",
  "guten tag": "de",
  "guten morgen": "de",
  namaste: "hi",
  ola: "pt",
  привет: "ru",
  здравствуйте: "ru",
  "こんにちは": "ja",
  "こんばんは": "ja",
  おはよう: "ja",
  "おはようございます": "ja",
  やあ: "ja",
};

const GREETING_TEMPLATES = {
  en: (company) =>
    `<p>Hi! How can I help you with <strong>${company}</strong> today?</p>`,
  es: (company) =>
    `<p>¡Hola! ¿En qué puedo ayudarte con <strong>${company}</strong> hoy?</p>`,
  fr: (company) =>
    `<p>Bonjour ! Comment puis-je vous aider avec <strong>${company}</strong> aujourd'hui ?</p>`,
  de: (company) =>
    `<p>Hallo! Wie kann ich Ihnen heute bei <strong>${company}</strong> helfen?</p>`,
  it: (company) =>
    `<p>Ciao! Come posso aiutarti con <strong>${company}</strong> oggi?</p>`,
  pt: (company) =>
    `<p>Olá! Como posso ajudá-lo com <strong>${company}</strong> hoje?</p>`,
  ru: (company) =>
    `<p>Здравствуйте! Чем могу помочь вам с <strong>${company}</strong> сегодня?</p>`,
  ja: (company) =>
    `<p>こんにちは！今日は<strong>${company}</strong>についてどのようにお手伝いできますか？</p>`,
  hi: (company) =>
    `<p>नमस्ते! आज मैं <strong>${company}</strong> के बारे में आपकी कैसे मदद कर सकता हूँ?</p>`,
};

const LIVE_AGENT_TEMPLATES = {
  en: (company) =>
    `<p>Of course! I'll connect you with a team member from <strong>${company}</strong> shortly.</p>`,
  es: (company) =>
    `<p>¡Por supuesto! En breve le conectaré con un miembro del equipo de <strong>${company}</strong>.</p>`,
  fr: (company) =>
    `<p>Bien sûr ! Je vous mets en relation avec un membre de l'équipe <strong>${company}</strong> dans un instant.</p>`,
  de: (company) =>
    `<p>Natürlich! Ich verbinde Sie gleich mit einem Teammitglied von <strong>${company}</strong>.</p>`,
  it: (company) =>
    `<p>Certo! Ti metterò in contatto con un membro del team di <strong>${company}</strong> a breve.</p>`,
  pt: (company) =>
    `<p>Claro! Vou conectá-lo com um membro da equipe <strong>${company}</strong> em breve.</p>`,
  ru: (company) =>
    `<p>Конечно! Скоро я соединю вас с сотрудником <strong>${company}</strong>.</p>`,
  ja: (company) =>
    `<p>かしこまりました。まもなく<strong>${company}</strong>の担当者におつなぎします。</p>`,
  hi: (company) =>
    `<p>बिल्कुल! मैं आपको जल्द ही <strong>${company}</strong> की टीम के सदस्य से जोड़ दूँगा।</p>`,
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function detectScriptLanguage(text) {
  const sample = String(text || "");
  if (/[\u0400-\u04FF]/.test(sample)) return "ru";
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(sample)) return "ja";
  if (/[\u0900-\u097F]/.test(sample)) return "hi";
  return null;
}

function normalizeGreetingInput(question) {
  let normalized = String(question || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  normalized = normalized.replace(/^[!?.…,]+|[!?.…,]+$/g, "").trim();
  return normalized;
}

function languageFromGreetingPhrase(question) {
  const normalized = normalizeGreetingInput(question);
  if (!normalized) return null;

  if (GREETING_LANGUAGE_BY_PHRASE[normalized]) {
    return GREETING_LANGUAGE_BY_PHRASE[normalized];
  }

  const withoutBang = normalized.replace(/!+$/g, "").trim();
  if (GREETING_LANGUAGE_BY_PHRASE[withoutBang]) {
    return GREETING_LANGUAGE_BY_PHRASE[withoutBang];
  }

  if (/^h+i+$/i.test(normalized)) return "en";
  if (/^he+y+$/i.test(normalized)) return "en";
  if (/^hell+o+$/i.test(normalized)) return "en";

  return null;
}

/**
 * True when we can confidently map the greeting itself to a language (e.g. "привет", "hola").
 * Returns false for ambiguous Latin-typo greetings like "hii"/"heyy" which should prefer
 * visitorLocale/router language.
 */
function isKnownGreetingPhrase(question) {
  const normalized = normalizeGreetingInput(question);
  if (!normalized) return false;
  if (GREETING_LANGUAGE_BY_PHRASE[normalized]) return true;
  const withoutBang = normalized.replace(/!+$/g, "").trim();
  if (GREETING_LANGUAGE_BY_PHRASE[withoutBang]) return true;
  return false;
}

function resolveReplyLanguage({
  userMessage,
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
}) {
  const resolved = resolveUserLanguage({
    routingUserLanguage,
    visitorLocale,
    websiteLanguage,
  });

  if (resolved !== "en") return resolved;

  const fromGreeting = languageFromGreetingPhrase(userMessage);
  if (fromGreeting) return fromGreeting;

  return resolved;
}

const OFF_TOPIC_TEMPLATES = {
  en: (company) =>
    `<p>I'm here to help with questions about <strong>${company}</strong>. Is there something specific about our products or services I can help you with?</p>`,
  es: (company) =>
    `<p>Estoy aquí para ayudarte con preguntas sobre <strong>${company}</strong>. ¿Hay algo específico sobre nuestros productos o servicios en lo que pueda ayudarte?</p>`,
  fr: (company) =>
    `<p>Je suis là pour répondre aux questions sur <strong>${company}</strong>. Y a-t-il quelque chose de précis concernant nos produits ou services dont je peux vous parler ?</p>`,
  de: (company) =>
    `<p>Ich helfe Ihnen gerne bei Fragen zu <strong>${company}</strong>. Gibt es etwas Bestimmtes zu unseren Produkten oder Dienstleistungen, wobei ich helfen kann?</p>`,
  it: (company) =>
    `<p>Sono qui per aiutarti con domande su <strong>${company}</strong>. C'è qualcosa di specifico sui nostri prodotti o servizi in cui posso aiutarti?</p>`,
  pt: (company) =>
    `<p>Estou aqui para ajudar com perguntas sobre <strong>${company}</strong>. Há algo específico sobre nossos produtos ou serviços em que eu possa ajudar?</p>`,
  ru: (company) =>
    `<p>Я здесь, чтобы помочь с вопросами о <strong>${company}</strong>. Могу ли я помочь вам с чем-то конкретным о наших продуктах или услугах?</p>`,
  ja: (company) =>
    `<p><strong>${company}</strong>に関するご質問にお答えします。製品やサービスについて具体的にお手伝いできることはありますか？</p>`,
  hi: (company) =>
    `<p>मैं <strong>${company}</strong> से जुड़े सवालों में मदद के लिए यहाँ हूँ। क्या हमारे उत्पादों या सेवाओं के बारे में कुछ विशेष है जिसमें मैं मदद कर सकूँ?</p>`,
};

const IRRELEVANT_TEMPLATES = {
  en: (company) =>
    `<p>That question seems outside what I can help with for <strong>${company}</strong>. I'd be happy to answer questions about our products, services, pricing, or policies — what would you like to know?</p>`,
  es: (company) =>
    `<p>Esa pregunta parece estar fuera de lo que puedo ayudarle con <strong>${company}</strong>. Con gusto responderé preguntas sobre nuestros productos, servicios, precios o políticas. ¿Qué le gustaría saber?</p>`,
  fr: (company) =>
    `<p>Cette question semble hors de ce que je peux traiter pour <strong>${company}</strong>. Je serais ravi de répondre à vos questions sur nos produits, services, tarifs ou politiques — que souhaitez-vous savoir ?</p>`,
  de: (company) =>
    `<p>Diese Frage liegt außerhalb dessen, wobei ich bei <strong>${company}</strong> helfen kann. Gerne beantworte ich Fragen zu unseren Produkten, Dienstleistungen, Preisen oder Richtlinien — was möchten Sie wissen?</p>`,
  it: (company) =>
    `<p>Questa domanda sembra al di fuori di ciò che posso aiutare con <strong>${company}</strong>. Sarò felice di rispondere a domande su prodotti, servizi, prezzi o policy — cosa vorresti sapere?</p>`,
  pt: (company) =>
    `<p>Essa pergunta parece estar fora do que posso ajudar com <strong>${company}</strong>. Ficarei feliz em responder perguntas sobre nossos produtos, serviços, preços ou políticas — o que você gostaria de saber?</p>`,
  ru: (company) =>
    `<p>Этот вопрос, похоже, выходит за рамки того, чем я могу помочь по <strong>${company}</strong>. С радостью отвечу на вопросы о наших продуктах, услугах, ценах или политике — что вас интересует?</p>`,
  ja: (company) =>
    `<p>そのご質問は<strong>${company}</strong>のサポート範囲外のようです。製品、サービス、料金、ポリシーについてお答えできます。何について知りたいですか？</p>`,
  hi: (company) =>
    `<p>यह सवाल <strong>${company}</strong> से जुड़ी मदद से बाहर लगता है। मैं हमारे उत्पादों, सेवाओं, कीमतों या नीतियों के बारे में सवालों का जवाब दे सकता हूँ — आप क्या जानना चाहेंगे?</p>`,
};

const ACCIDENTAL_TEMPLATES = {
  en: (company) =>
    `<p>It looks like that message might have been sent by accident. How can I help you with <strong>${company}</strong> today?</p>`,
  es: (company) =>
    `<p>Parece que ese mensaje se envió por accidente. ¿En qué puedo ayudarte con <strong>${company}</strong> hoy?</p>`,
  fr: (company) =>
    `<p>Il semble que ce message ait été envoyé par accident. Comment puis-je vous aider avec <strong>${company}</strong> aujourd'hui ?</p>`,
  de: (company) =>
    `<p>Sieht so aus, als wäre diese Nachricht versehentlich gesendet worden. Wie kann ich Ihnen heute bei <strong>${company}</strong> helfen?</p>`,
  it: (company) =>
    `<p>Sembra che quel messaggio sia stato inviato per errore. Come posso aiutarti con <strong>${company}</strong> oggi?</p>`,
  pt: (company) =>
    `<p>Parece que essa mensagem foi enviada por engano. Como posso ajudá-lo com <strong>${company}</strong> hoje?</p>`,
  ru: (company) =>
    `<p>Похоже, это сообщение было отправлено случайно. Чем могу помочь вам с <strong>${company}</strong> сегодня?</p>`,
  ja: (company) =>
    `<p>メッセージが誤って送信されたようです。今日は<strong>${company}</strong>についてどのようにお手伝いできますか？</p>`,
  hi: (company) =>
    `<p>लगता है यह संदेश गलती से भेजा गया था। आज मैं <strong>${company}</strong> के बारे में आपकी कैसे मदद कर सकता हूँ?</p>`,
};

const KEYBOARD_MASH_PATTERN =
  /^(asdf|qwer|zxcv|hjkl|dfgh|jklj|fafafa|blah|lorem)+/i;

function vowelRatio(text) {
  const letters = String(text || "").toLowerCase();
  if (!letters.length) return 0;
  const vowels = (
    letters.match(/[aeiouyáéíóúàèìòùäëïöüаеёиоуыэюя]/g) || []
  ).length;
  return vowels / letters.length;
}

function isRepeatedPattern(text) {
  if (text.length < 6) return false;
  const mid = Math.floor(text.length / 2);
  return text.slice(0, mid) === text.slice(mid);
}

/** True when the message contains real letters from common non-Latin scripts. */
function hasMeaningfulUnicodeScript(text) {
  return /[\u3040-\u30FF\u4E00-\u9FFF\u0400-\u04FF\u0900-\u097F\u0600-\u06FF]/u.test(
    String(text || "")
  );
}

/**
 * Detect random typing, keyboard mash, or test input that should not hit RAG/LLM.
 */
function isGibberishOrAccidentalMessage(question) {
  const raw = String(question || "").trim();
  if (raw.length < 3) return false;

  // Japanese, Russian, Hindi, Arabic, etc. are never gibberish by punctuation rules.
  if (hasMeaningfulUnicodeScript(raw)) return false;

  // Symbols / digits only (Latin punctuation), not real words.
  if (/^[\d\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/u.test(raw)) return true;
  if (/^test(ing)?[!?.]*$/i.test(raw)) return true;

  const normalized = raw.toLowerCase();
  const hasSpaces = /\s/.test(raw);
  const words = raw.split(/\s+/).filter(Boolean);

  if (!hasSpaces) {
    if (isRepeatedPattern(normalized)) return true;
    if (KEYBOARD_MASH_PATTERN.test(normalized)) return true;

    if (/^[a-z]+$/i.test(raw) && raw.length >= 8) {
      const uniqueRatio = new Set(normalized).size / raw.length;
      const vowels = vowelRatio(raw);

      if (uniqueRatio < 0.4 && raw.length >= 10) return true;
      if (vowels < 0.15 && raw.length >= 8) return true;
      if (vowels < 0.22 && uniqueRatio < 0.5 && raw.length >= 12) return true;
    }

    if (raw.length >= 12 && /^[a-z]+$/i.test(raw)) {
      const uniqueRatio = new Set(normalized).size / raw.length;
      if (uniqueRatio < 0.45) return true;
    }
  } else if (words.length > 0) {
    const allLongGibberish = words.every(
      (word) =>
        word.length >= 5 &&
        /^[a-z]+$/i.test(word) &&
        vowelRatio(word) < 0.2
    );
    if (allLongGibberish && words.length >= 1) return true;
  }

  return false;
}

function buildAccidentalResponse({
  companyName,
  userMessage,
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const language = resolveReplyLanguage({
    userMessage,
    routingUserLanguage,
    visitorLocale,
    websiteLanguage,
  });
  const template = pickTemplate(ACCIDENTAL_TEMPLATES, language);
  return {
    answer: template(safeCompany),
    language,
    source: "lightweight_accidental",
  };
}

function pickTemplate(templates, language) {
  const lang = normalizeLanguageCode(language) || "en";
  const template = templates[lang] || templates.en;
  return template;
}

function buildGreetingResponse({
  companyName,
  userMessage,
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const language = resolveReplyLanguage({
    userMessage,
    routingUserLanguage,
    visitorLocale,
    websiteLanguage,
  });
  const template = pickTemplate(GREETING_TEMPLATES, language);
  return {
    answer: template(safeCompany),
    language,
    source: "lightweight_greeting",
  };
}

function buildLiveAgentResponse({
  companyName,
  userMessage,
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const language = resolveReplyLanguage({
    userMessage,
    routingUserLanguage,
    visitorLocale,
    websiteLanguage,
  });
  const template = pickTemplate(LIVE_AGENT_TEMPLATES, language);
  return {
    answer: template(safeCompany),
    language,
    source: "lightweight_live_agent",
  };
}

function buildOffTopicResponse({
  companyName,
  userMessage,
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
  isIrrelevant = false,
}) {
  const safeCompany = escapeHtml(companyName || "our team");
  const language = resolveReplyLanguage({
    userMessage,
    routingUserLanguage,
    visitorLocale,
    websiteLanguage,
  });
  const templates = isIrrelevant ? IRRELEVANT_TEMPLATES : OFF_TOPIC_TEMPLATES;
  const template = pickTemplate(templates, language);
  return {
    answer: template(safeCompany),
    language,
    source: isIrrelevant ? "lightweight_irrelevant" : "lightweight_off_topic",
  };
}

module.exports = {
  buildGreetingResponse,
  buildLiveAgentResponse,
  buildAccidentalResponse,
  buildOffTopicResponse,
  isGibberishOrAccidentalMessage,
  hasMeaningfulUnicodeScript,
  isKnownGreetingPhrase,
  detectScriptLanguage,
  resolveReplyLanguage,
  normalizeGreetingInput,
  languageFromGreetingPhrase,
};
