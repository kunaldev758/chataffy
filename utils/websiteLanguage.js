/**
 * Website language detection during scrape/training and normalization helpers.
 */

function normalizeLanguageCode(raw) {
  if (!raw || typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(code)) return null;
  return code;
}

const COMMON_WORDS = {
  en: ["the", "and", "for", "with", "your", "our", "about", "contact", "home", "products"],
  de: ["und", "der", "die", "das", "für", "ihre", "kontakt", "startseite", "produkte"],
  fr: ["les", "des", "pour", "avec", "votre", "notre", "contact", "accueil", "produits"],
  es: ["los", "las", "para", "con", "su", "nuestro", "contacto", "inicio", "productos"],
  it: ["per", "con", "nostro", "contatto", "prodotti", "casa", "della", "delle"],
  pt: ["para", "com", "nosso", "contato", "produtos", "início", "sobre"],
  nl: ["voor", "met", "onze", "contact", "producten", "home", "over"],
  hi: ["और", "के", "में", "है", "हमारे", "संपर्क", "उत्पाद"],
};

function detectLanguageFromText(text) {
  const sample = (text || "").toLowerCase().slice(0, 4000);
  if (sample.length < 40) return null;

  const tokens = sample.match(/[\p{L}\p{M}]{2,}/gu) || [];
  if (tokens.length < 8) return null;

  let bestLang = null;
  let bestScore = 0;

  for (const [lang, words] of Object.entries(COMMON_WORDS)) {
    let score = 0;
    for (const word of words) {
      if (sample.includes(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  if (!bestLang || bestScore < 2) return null;
  return { language: bestLang, confidence: Math.min(0.75, 0.4 + bestScore * 0.05) };
}

function detectLanguageFromHtml($) {
  const htmlLang = normalizeLanguageCode($("html").attr("lang"));
  const ogLocale = $("meta[property='og:locale']").attr("content");
  const contentLang = $("meta[http-equiv='content-language']").attr("content");

  const ogNorm = ogLocale ? normalizeLanguageCode(ogLocale) : null;
  const contentNorm = contentLang
    ? normalizeLanguageCode(contentLang.split(",")[0])
    : null;

  if (htmlLang) {
    return { language: htmlLang, source: "html_lang", confidence: 0.9 };
  }
  if (ogNorm) {
    return { language: ogNorm, source: "og_locale", confidence: 0.85 };
  }
  if (contentNorm) {
    return {
      language: contentNorm,
      source: "content_language",
      confidence: 0.8,
    };
  }
  return null;
}

function detectLanguagesFromHreflang($) {
  const langs = new Set();
  $("link[rel='alternate'][hreflang]").each((_, el) => {
    const hreflang = $(el).attr("hreflang");
    if (!hreflang || hreflang === "x-default") return;
    const normalized = normalizeLanguageCode(hreflang);
    if (normalized) langs.add(normalized);
  });
  return Array.from(langs);
}

/**
 * Detect primary website language from scraped HTML + optional body text.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} [bodyText]
 */
function detectWebsiteLanguage($, bodyText = "") {
  const htmlResult = detectLanguageFromHtml($);
  const hreflangs = detectLanguagesFromHreflang($);

  let primary = htmlResult?.language || null;
  let languages = [...hreflangs];

  if (primary && !languages.includes(primary)) {
    languages.unshift(primary);
  } else if (!primary && languages.length > 0) {
    primary = languages[0];
  }

  let languageSource = htmlResult?.source || null;
  let languageConfidence = htmlResult?.confidence ?? null;

  if (!primary && bodyText) {
    const contentResult = detectLanguageFromText(bodyText);
    if (contentResult) {
      primary = contentResult.language;
      languages = [primary];
      languageSource = "content_detection";
      languageConfidence = contentResult.confidence;
    }
  }

  if (!primary) {
    primary = "en";
    languages = ["en"];
    languageSource = "default";
    languageConfidence = 0.3;
  }

  if (languages.length === 0) {
    languages = [primary];
  }

  return {
    primary_language: primary,
    languages,
    language_confidence: languageConfidence ?? 0.5,
    language_source: languageSource || "default",
  };
}

/**
 * Resolve the language to use for replies.
 * Priority: LLM router > browser locale > website language > en.
 */
function resolveUserLanguage({
  routingUserLanguage,
  visitorLocale,
  websiteLanguage,
} = {}) {
  const fromRouting = normalizeLanguageCode(routingUserLanguage);
  if (fromRouting) return fromRouting;

  const fromVisitor = normalizeLanguageCode(visitorLocale);
  if (fromVisitor) return fromVisitor;

  const fromWebsite = normalizeLanguageCode(websiteLanguage);
  if (fromWebsite) return fromWebsite;

  return "en";
}

module.exports = {
  normalizeLanguageCode,
  detectWebsiteLanguage,
  detectLanguageFromText,
  resolveUserLanguage,
};