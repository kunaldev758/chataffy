/**
 * Detect business-support questions that should never be treated as off-topic
 * based only on low embedding similarity scores.
 * Patterns cover English + Spanish, French, German, Japanese, Russian, Hindi.
 */

// ── English on-topic patterns ─────────────────────────────────────────────
const ON_TOPIC_PATTERNS = [
  /\b(?:tell\s+me|explain|describe)\s+(?:about\s+)?(?:your|our|the)\s+(?:services?|products?|company|business|offerings?|platform|app|tool|solution|features?|pricing|plans?)\b/i,
  /\b(?:what|which)\s+(?:are|is)\s+(?:your|our)\s+(?:services?|products?|features?|plans?|pricing|prices?|offerings?)\b/i,
  /\b(?:describe|introduce)\s+(?:yourself|your\s+company|the\s+company|you)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bwhat\s+do\s+you\s+do\b/i,
  /\bwhat\s+(?:is|does)\s+\w+\s+do\b/i,
  /\b(?:about\s+you|about\s+your\s+company|about\s+the\s+company)\b/i,
  /\b(?:your|our)\s+(?:services?|products?|pricing|prices?|features?|benefits?|plans?|policies?)\b/i,
  /\b(?:how\s+(?:much|do\s+i|can\s+i|does)|pricing|refund|return|shipping|warranty|support|billing|cancel)\b/i,
  /\b(?:contact|phone|email|address|hours|office)\b/i,
  /\bhow\s+(?:does|do)\s+(?:it|this|your|the)\s+(?:work|help)\b/i,
];

// ── Spanish on-topic patterns ─────────────────────────────────────────────
const ES_ON_TOPIC_PATTERNS = [
  /\b(?:qué|cuáles?)\s+(?:son|es)\s+(?:sus?|vuestros?|tus?)\s+(?:productos?|servicios?|precios?|planes?)\b/i,
  /\b(?:precio|precios|coste|costos?|cuánto\s+cuesta|cuánto\s+vale)\b/i,
  /\b(?:cómo\s+funciona|para\s+qué\s+sirve|qué\s+ofrecen?)\b/i,
  /\b(?:envío|devolución|reembolso|garantía|soporte|contacto)\b/i,
  /\b(?:quiénes?\s+son|de\s+qué\s+se\s+trata|cuéntame\s+sobre)\b/i,
];

// ── French on-topic patterns ──────────────────────────────────────────────
const FR_ON_TOPIC_PATTERNS = [
  /\b(?:quels?\s+sont|qu'est-ce\s+que)\s+(?:vos|votre|tes|ton)\s+(?:produits?|services?|prix|offres?|plans?)\b/i,
  /\b(?:prix|tarif|coût|combien|livraison|remboursement|garantie)\b/i,
  /\b(?:comment\s+ça\s+fonctionne|à\s+quoi\s+ça\s+sert|que\s+proposez-vous)\b/i,
  /\b(?:contactez?|adresse|téléphone|horaires?|support)\b/i,
  /\b(?:qui\s+êtes-vous|parlez-moi\s+de|à\s+propos\s+de\s+vous)\b/i,
];

// ── German on-topic patterns ──────────────────────────────────────────────
const DE_ON_TOPIC_PATTERNS = [
  /\b(?:was\s+(?:sind|ist|kostet|kosten)|welche)\s+(?:produkte?|dienstleistungen?|preise?|pläne?|angebote?)\b/i,
  /\b(?:preis|preise|kosten|versand|rückgabe|garantie|support|kontakt)\b/i,
  /\b(?:wie\s+funktioniert|wofür|was\s+machen\s+sie|erzählen\s+sie\s+mir)\b/i,
  /\b(?:wer\s+sind\s+sie|über\s+(?:uns|ihr\s+unternehmen|euch))\b/i,
];

// ── Japanese on-topic patterns ────────────────────────────────────────────
const JA_ON_TOPIC_PATTERNS = [
  /価格|値段|料金|費用|いくら|送料|返金|保証|サポート|お問い合わせ/,
  /商品|製品|サービス|プラン|機能|特徴|会社|について|教えて/,
  /どのように機能|何ができる|何を提供/,
];

// ── Russian on-topic patterns ─────────────────────────────────────────────
const RU_ON_TOPIC_PATTERNS = [
  /цена|стоимость|сколько\s+стоит|тариф|доставка|возврат|гарантия/i,
  /продукт|товар|услуга|план|функция|контакт|поддержка/i,
  /как\s+это\s+работает|что\s+вы\s+предлагаете|расскажите\s+о/i,
  /кто\s+вы|о\s+компании|о\s+вас/i,
];

// ── Hindi on-topic patterns ───────────────────────────────────────────────
const HI_ON_TOPIC_PATTERNS = [
  /कीमत|मूल्य|दाम|कितना|शिपिंग|वापसी|वारंटी|सहायता|संपर्क/,
  /उत्पाद|सेवा|प्लान|फ़ीचर|कंपनी|के बारे में|बताइए/,
];

const MULTILINGUAL_ON_TOPIC_PATTERNS = [
  ...ES_ON_TOPIC_PATTERNS,
  ...FR_ON_TOPIC_PATTERNS,
  ...DE_ON_TOPIC_PATTERNS,
  ...JA_ON_TOPIC_PATTERNS,
  ...RU_ON_TOPIC_PATTERNS,
  ...HI_ON_TOPIC_PATTERNS,
];

// ── Identity patterns (English only — LLM handles non-English) ───────────
const IDENTITY_PATTERNS = [
  /\b(?:describe|introduce)\s+(?:yourself|your\s+company|the\s+company|you)\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\babout\s+you\b/i,
  /\bwhat\s+do\s+you\s+do\b/i,
];

/** General knowledge / unrelated topics — safe to redirect with a template. */
const TRULY_OFF_TOPIC_PATTERNS = [
  /\b(?:weather|forecast|temperature)\b/i,
  /\b(?:tell\s+me\s+a\s+joke|make\s+me\s+laugh)\b/i,
  /\b(?:who\s+won|football|soccer|cricket|nba|nfl)\b/i,
  /\b(?:recipe|cook|bake)\s+/i,
  /\b(?:stock\s+price|bitcoin|crypto)\b/i,
  /\b(?:president|prime\s+minister)\s+of\b/i,
];

function isClearlyOnTopicCompanyQuestion(question, companyName = "") {
  const q = String(question || "").trim();
  if (!q) return false;
  return (
    ON_TOPIC_PATTERNS.some((re) => re.test(q)) ||
    MULTILINGUAL_ON_TOPIC_PATTERNS.some((re) => re.test(q)) ||
    isCompanyIdentityQuestion(q, companyName)
  );
}

function isCompanyIdentityQuestion(question, companyName = "") {
  const q = String(question || "").trim();
  if (!q) return false;
  if (IDENTITY_PATTERNS.some((re) => re.test(q))) return true;
  const company = String(companyName || "").trim();
  if (company.length >= 3) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const companyRe = new RegExp(
      `\\bwhat\\s+is\\s+${escaped}\\b`,
      "i"
    );
    if (companyRe.test(q)) return true;
  }
  return false;
}

function isTrulyOffTopicQuestion(question) {
  const q = String(question || "").trim();
  if (!q) return false;
  if (isClearlyOnTopicCompanyQuestion(q)) return false;
  return TRULY_OFF_TOPIC_PATTERNS.some((re) => re.test(q));
}

module.exports = {
  isClearlyOnTopicCompanyQuestion,
  isCompanyIdentityQuestion,
  isTrulyOffTopicQuestion,
};
