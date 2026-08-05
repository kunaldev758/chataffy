const { completeLlama } = require("./LlamaClient");
const {
  extractContactFacts,
  buildContactListHtml,
  formatContactFromMatches,
} = require("./StructuredResponseFormatter");
const { normalizeLanguageCode } = require("../utils/websiteLanguage");

const CONTACT_INTRO = {
  en: "Here is our contact information:",
  ja: "連絡先はこちらです：",
  de: "Hier sind unsere Kontaktdaten:",
  fr: "Voici nos coordonnées :",
  es: "Aquí está nuestra información de contacto:",
  it: "Ecco i nostri recapiti:",
  pt: "Aqui estão nossas informações de contato:",
  ru: "Вот наша контактная информация:",
  hi: "यहाँ हमारी संपर्क जानकारी है:",
};

const CONTACT_HEADINGS = {
  en: { title: "Contact Us", section: "Contact details" },
  ja: { title: "お問い合わせ", section: "連絡先" },
  de: { title: "Kontakt", section: "Kontaktdaten" },
  fr: { title: "Nous contacter", section: "Coordonnées" },
  es: { title: "Contáctanos", section: "Datos de contacto" },
  it: { title: "Contattaci", section: "Recapiti" },
  pt: { title: "Fale conosco", section: "Dados de contato" },
  ru: { title: "Свяжитесь с нами", section: "Контактные данные" },
  hi: { title: "हमसे संपर्क करें", section: "संपर्क विवरण" },
};

const FIELD_LABELS = {
  en: { email: "Email", phone: "Phone" },
  ja: { email: "メール", phone: "電話" },
  de: { email: "E-Mail", phone: "Telefon" },
  fr: { email: "E-mail", phone: "Téléphone" },
  es: { email: "Correo", phone: "Teléfono" },
  it: { email: "Email", phone: "Telefono" },
  pt: { email: "E-mail", phone: "Telefone" },
  ru: { email: "Эл. почта", phone: "Телефон" },
  hi: { email: "ईमेल", phone: "फ़ोन" },
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveLanguage(userLanguage) {
  return normalizeLanguageCode(userLanguage) || "en";
}

function pickIntro(language) {
  return CONTACT_INTRO[language] || CONTACT_INTRO.en;
}

function pickFieldLabels(language) {
  return FIELD_LABELS[language] || FIELD_LABELS.en;
}

function wrapIntroParagraph(intro) {
  const text = String(intro || "").trim();
  if (!text) return "";
  if (/<\s*p[\s>]/i.test(text)) return text;
  return `<p>${text}</p>`;
}

function buildContactHeader(intro, language) {
  const headings = CONTACT_HEADINGS[language] || CONTACT_HEADINGS.en;
  return `<h1>${escapeHtml(headings.title)}</h1>${wrapIntroParagraph(escapeHtml(intro))}<h2>${escapeHtml(headings.section)}</h2>`;
}

function wrapGeneratedContactHeader(header) {
  const html = String(header || "").trim();
  if (/<\s*h1[\s>]/i.test(html) && /<\s*h2[\s>]/i.test(html)) {
    return html;
  }
  return `<h1>Contact Us</h1>${wrapIntroParagraph(html)}<h2>Contact details</h2>`;
}

function buildTemplateContactAnswer(facts, language) {
  const intro = pickIntro(language);
  const listHtml = buildContactListHtml(facts, pickFieldLabels(language));
  return `${buildContactHeader(intro, language)}${listHtml}`;
}

function responseContainsFacts(answer, facts) {
  const haystack = String(answer || "").toLowerCase();
  return facts.every((fact) => {
    const needle = String(fact.value || fact.url || "").toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * Localized contact reply: deterministic facts + template or Llama intro.
 * Skips OpenAI when contact details are explicit in retrieval matches.
 */
async function generateContactResponse({
  companyName,
  userMessage,
  userLanguage,
  matches,
  userId = null,
  agentId = null,
  conversationId = null,
}) {
  const facts = extractContactFacts(matches);
  if (facts.length === 0) return null;

  const language = resolveLanguage(userLanguage);
  const listHtml = buildContactListHtml(facts, pickFieldLabels(language));

  if (language === "en") {
    const headings = CONTACT_HEADINGS.en;
    return {
      answer: formatContactFromMatches(matches, {
        title: headings.title,
        intro: CONTACT_INTRO.en,
        sectionTitle: headings.section,
        fieldLabels: FIELD_LABELS.en,
      }),
      language,
      source: "structured_contact",
    };
  }

  if (CONTACT_INTRO[language]) {
    return {
      answer: buildTemplateContactAnswer(facts, language),
      language,
      source: "template_contact",
    };
  }

  const system = [
    "You write a short customer-support heading and intro before a contact list.",
    `Write in language code: ${language}.`,
    "Output HTML only in this exact order: one concise <h1> title, one brief <p> intro sentence, then one <h2> contact-details heading.",
    "Do not output markdown or a bullet list.",
    "Do not include phone numbers, emails, or URLs — only the intro sentence.",
  ].join(" ");

  const prompt = [
    `Company: ${companyName || "the company"}`,
    `Visitor asked: ${JSON.stringify(String(userMessage || ""))}`,
    `Write the intro in ${language}.`,
  ].join("\n");

  const introRaw = await completeLlama({
    system,
    prompt,
    feature: "contact",
    maxTokens: 80,
    userId,
    agentId,
    conversationId,
  });

  if (introRaw) {
    const answer = `${wrapGeneratedContactHeader(introRaw)}${listHtml}`;
    if (responseContainsFacts(answer, facts)) {
      return {
        answer,
        language,
        source: "llama_contact",
      };
    }
  }

  return {
    answer: buildTemplateContactAnswer(facts, language),
    language,
    source: "template_contact_fallback",
  };
}

module.exports = {
  generateContactResponse,
  CONTACT_INTRO,
  FIELD_LABELS,
};
