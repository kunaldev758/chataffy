/**
 * Multilingual contact-intent detection for routing and retrieval.
 * Used by QueryRouter, queryContextExpansion, and QueryController.
 */

const POLICY_MIX_RE =
  /\b(refund|return|policy|billing|order|shipping|warranty|cancel|payment|product|pricing|feature|plan)\b/i;

const ENGLISH_CONTACT_RE =
  /\b(social\s*media|phone\s*number|email\s*address|mailing\s*address|office\s*hours|business\s*hours|facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest|follow\s+us|find\s+us\s+on)\b/i;

const ENGLISH_CONTACT_PHRASE_RE =
  /\b(how\s+(?:do\s+i\s+)?contact|contact\s+(?:info|details|number|us)|reach\s+us|call\s+us)\b/i;

const ENGLISH_CONTACT_FIELD_RE =
  /\b(phone|email|e-mail|address|hours|fax|mailing)\b/i;

const ENGLISH_SOCIAL_LIST_RE =
  /\b(give\s+me|show\s+me|what\s+are|list)\b[\s\S]{0,30}\bsocial\b/i;

// Japanese
const JA_CONTACT_RE =
  /連絡先|お問い合わせ|問い合わせ|電話番号|メールアドレス|メール|住所|営業時間|所在地|sns|公式アカウント/i;

// German
const DE_CONTACT_RE =
  /\b(kontakt|kontaktieren|telefonnummer|e-?mail|adresse|öffnungszeiten|erreichbar)\b/i;

// French
const FR_CONTACT_RE =
  /\b(coordonnées|contactez|téléphone|adresse|courriel|horaires|joindre)\b/i;

// Spanish
const ES_CONTACT_RE =
  /\b(contacto|contactar|teléfono|correo|dirección|horario|redes\s+sociales)\b/i;

// Russian (Cyrillic)
const RU_CONTACT_RE =
  /контакт|телефон|электронн|адрес|связаться|часы\s+работы/i;

const MULTILINGUAL_CONTACT_RE = new RegExp(
  [
    JA_CONTACT_RE.source,
    DE_CONTACT_RE.source,
    FR_CONTACT_RE.source,
    ES_CONTACT_RE.source,
    RU_CONTACT_RE.source,
  ].join("|"),
  "i"
);

function isContactIntentQuestion(question) {
  const raw = String(question || "").trim();
  if (!raw) return false;

  const q = raw.toLowerCase();

  if (ENGLISH_CONTACT_RE.test(q)) return true;
  if (ENGLISH_CONTACT_PHRASE_RE.test(q) && !POLICY_MIX_RE.test(q)) return true;
  if (ENGLISH_CONTACT_FIELD_RE.test(q) && !POLICY_MIX_RE.test(q)) return true;
  if (ENGLISH_SOCIAL_LIST_RE.test(q)) return true;
  if (MULTILINGUAL_CONTACT_RE.test(raw)) return true;

  return false;
}

/**
 * Stricter check for specialized CONTACT_INFO retrieval (excludes policy-mixed questions).
 */
function isPrimarilyContactQuestion(question) {
  const raw = String(question || "").trim();
  if (!raw) return false;

  const q = raw.toLowerCase();
  const policyMix = POLICY_MIX_RE.test(q);
  const contactFocus =
    ENGLISH_CONTACT_RE.test(q) ||
    ENGLISH_CONTACT_PHRASE_RE.test(q) ||
    ENGLISH_SOCIAL_LIST_RE.test(q) ||
    MULTILINGUAL_CONTACT_RE.test(raw);

  if (policyMix && !contactFocus) return false;
  return contactFocus || (ENGLISH_CONTACT_FIELD_RE.test(q) && !policyMix);
}

module.exports = {
  isContactIntentQuestion,
  isPrimarilyContactQuestion,
};
