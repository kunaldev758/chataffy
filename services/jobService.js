require("dotenv").config();
const { Queue, Worker } = require("bullmq");
const Client = require("../models/Client.js");
const Agent = require("../models/Agent");
const Url = require("../models/Url.js");
const WebsiteData = require("../models/WebsiteData.js");
const batchTrainingService = require("./BatchTrainingService.js");
const appEvents = require("../events.js");
const axios = require("axios");
const cheerio = require("cheerio");
const urlModule = require("url");
const TurndownService = require("turndown");
const QdrantVectorStoreManager = require("./QdrantService");
const { buildTrainingProgressPayload } = require("../utils/trainingProgress.js");
const {
  isScrapableWebUrl,
  isHtmlContentType,
} = require("../utils/webUrlUtils.js");
const { detectWebsiteLanguage } = require("../utils/websiteLanguage");
const {
  classifyWebsiteType,
} = require("./LlamaWebsiteClassifierService");

const NON_HTML_SKIP_ERROR =
  "Non-HTML URL skipped. Use document upload for PDFs and other files.";

async function markWebUrlScrapeFailed({
  url,
  userId,
  agentId,
  TrainingModel,
  error,
}) {
  const existingFailRow = await TrainingModel.findOne({
    userId,
    agentId,
    "webPage.url": url,
  })
    .select("trainingStatus")
    .lean();
  const prevTrainStatus = existingFailRow?.trainingStatus;

  await TrainingModel.findOneAndUpdate(
    { userId, agentId, "webPage.url": url },
    {
      $set: {
        userId,
        agentId,
        type: 0,
        trainingStatus: 2,
        lastEdit: Date.now(),
        error,
        "webPage.url": url,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  if (prevTrainStatus !== 2) {
    const inc =
      prevTrainStatus === 1
        ? { "pagesAdded.success": -1, "pagesAdded.failed": 1 }
        : { "pagesAdded.failed": 1 };
    await Agent.updateOne({ _id: agentId }, { $inc: inc });
  }

  await Url.updateOne(
    { url, agentId },
    { $set: { trainStatus: 2, error } },
  );
}

const redisConfig =
  process.env.ENVIRONMENT === "local"
    ? { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null }
    : {
        host: "127.0.0.1",
        port: 6379,
        password: "root1234",
        maxRetriesPerRequest: null,
      };

function companyNameFromDomain(hostname) {
  if (!hostname) return "";
  const host = hostname.replace(/^www\./i, "").trim();
  const label = host.split(".")[0];
  if (!label || label.length < 2) return "";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const SOCIAL_PLATFORM_LABELS = [
  { pattern: /facebook\.com/i, label: "Facebook" },
  { pattern: /instagram\.com/i, label: "Instagram" },
  { pattern: /twitter\.com|x\.com/i, label: "Twitter / X" },
  { pattern: /youtube\.com/i, label: "YouTube" },
  { pattern: /tiktok\.com/i, label: "TikTok" },
  { pattern: /linkedin\.com/i, label: "LinkedIn" },
  { pattern: /pinterest\.com/i, label: "Pinterest" },
];

/** Label icon-only footer links (e.g. social icons) so RAG can match platform names. */
function enrichFooterHtml(footerHTML) {
  if (!footerHTML) return footerHTML;
  const $ = cheerio.load(footerHTML, { decodeEntities: true });

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href) return;

    for (const { pattern, label } of SOCIAL_PLATFORM_LABELS) {
      if (pattern.test(href)) {
        $(el).empty().text(`${label}: ${href}`);
        return;
      }
    }

    if (href.startsWith("mailto:")) {
      const email = href.replace(/^mailto:/i, "").split("?")[0];
      if (email) $(el).text(`Email: ${email}`);
      return;
    }

    if (href.startsWith("tel:")) {
      const phone = href.replace(/^tel:/i, "");
      if (phone) $(el).text(`Phone: ${phone}`);
    }
  });

  return $.root().html() || footerHTML;
}

// Helper function to extract website metadata from HTML
const extractWebsiteMetadata = ($, url, { isHomepage = false } = {}) => {
  const metadata = {
    company_name: "",
    company_type: "",
    industry: "",
    founded_year: "",
    services_list: [],
    value_proposition: "",
    does_not_list: [],
    website_url: url,
    domain: new URL(url).hostname,
  };

  try {
    const title = $("title").text().trim();
    const h1 = $("h1").first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
    const siteName = $('meta[property="og:site_name"]').attr("content")?.trim();
    const domainName = companyNameFromDomain(metadata.domain);

    if (isHomepage) {
      metadata.company_name =
        siteName ||
        ogTitle ||
        title.split("|")[0].split("-")[0].trim() ||
        h1 ||
        title ||
        domainName;
    } else {
      metadata.company_name = siteName || domainName;
    }
    const keywords =
      $('meta[name="keywords"]').attr("content")?.toLowerCase() || "";
    const description =
      $('meta[name="description"]').attr("content")?.toLowerCase() || "";
    const combinedText = (keywords + " " + description).toLowerCase();

    const schemaTypes = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).contents().text() || $(el).text());
        const collect = (node) => {
          if (!node) return;
          if (Array.isArray(node)) return node.forEach(collect);
          if (typeof node === "object") {
            const t = node["@type"];
            if (typeof t === "string") schemaTypes.push(t.toLowerCase());
            else if (Array.isArray(t))
              t.forEach((x) => typeof x === "string" && schemaTypes.push(x.toLowerCase()));
            if (node["@graph"]) collect(node["@graph"]);
          }
        };
        collect(parsed);
      } catch (_) {
       
      }
    });

   
    const classifyText = [title, h1, ogTitle, keywords, description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

   
    const typeDefinitions = [
      {
        type: "SaaS Website",
        schema: ["softwareapplication", "saas", "cloudservice"],
        keywords: [
          "saas", "software as a service", "cloud software", "cloud-based",
          "ai-powered", "ai chatbot", "customer service outsourcing", "cx",
          "hybrid support", "24/7 support", "outsource", "outsourcing",
          "subscription", "pricing plan", "per month", "free trial",
          "b2b", "platform", "api", "integration", "automation",
          "dashboard", "analytics", "real-time", "enterprise solution",
          "workflow", "productivity", "collaboration", "project management"
        ]
      },

      {
        type: "E-commerce Website",
        schema: ["product", "offer", "onlinestore", "store", "shopping"],
        keywords: [
          "e-commerce", "ecommerce", "online store", "add to cart", "shop now",
          "buy online", "checkout", "shopping cart", "free shipping",
          "products", "purchase", "order now", "price", "discount",
          "sale", "deal", "coupon", "promo code", "wishlist",
          "size guide", "returns", "refund", "buy now", "pay"
        ]
      },

      {
        type: "Job Portal",
        schema: ["jobposting", "employeraggregate"],
        keywords: [
          "job portal", "jobs", "careers", "hiring", "vacancy",
          "vacancies", "recruitment", "apply now", "resume", "find jobs",
          "post a job", "job search", "career opportunity", "employment",
          "job listing", "job opening", "candidate", "employer",
          "salary", "work from home", "remote job", "full-time", "part-time"
        ]
      },      
      {
        type: "Real Estate Website",
        schema: ["realestatelisting", "residence", "apartment", "house", "singlefamilyresidence"],
        keywords: [
          "real estate", "property", "properties", "for sale", "for rent",
          "realty", "listings", "square feet", "bedroom", "mortgage",
          "house", "apartment", "condo", "villa", "land", "commercial property",
          "rental", "buy house", "sell property", "realtor", "agent",
          "home", "bathroom", "garage", "floor plan", "virtual tour"
        ]
      },
      {
        type: "Healthcare Website",
        schema: ["hospital", "medicalclinic", "physician", "medicalorganization", "dentist"],
        keywords: [
          "hospital", "clinic", "doctor", "patient", "healthcare",
          "medical", "telemedicine", "appointment", "treatment", "wellness",
          "health", "medicine", "surgery", "emergency", "consultation",
          "diagnosis", "therapy", "nutrition", "fitness", "pharmacy",
          "dental", "pediatric", "cardiology", "neurology", "orthopedic"
        ]
      },
      {
        type: "Banking/Finance Website",
        schema: ["bankorcreditunion", "financialservice"],
        keywords: [
          "banking", "bank", "investment", "loan", "credit card",
          "fintech", "payments", "insurance", "trading", "financial services",
          "savings", "account", "mortgage", "equity", "stock", "bond",
          "wealth", "portfolio", "retirement", "mutual fund", "interest"
        ]
      },
      {
        type: "Educational Website",
        schema: ["educationalorganization", "school", "collegeoruniversity", "course"],
        keywords: [
          "education", "e-learning", "online course", "courses", "school",
          "university", "college", "tutorial", "students", "enroll",
          "curriculum", "learn", "study", "academy", "program",
          "degree", "diploma", "certificate", "training", "workshop",
          "lesson", "class", "teacher", "instructor", "admission"
        ]
      },
      {
        type: "News Website",
        schema: ["newsarticle", "newsmediaorganization"],
        keywords: [
          "news", "breaking news", "headlines", "journalism", "latest news",
          "press", "reporter", "editorial", "newspaper", "media",
          "politics", "world news", "local news", "sports", "entertainment",
          "business news", "technology news", "health news", "opinion", "column"
        ]
      },{
        type: "Blog Website",
        schema: ["blog", "blogposting"],
        keywords: [
          "blog", "articles", "posts", "read more", "author",
          "recent posts", "categories", "tags", "blogger", "blogging",
          "comment", "subscribe", "newsletter", "featured", "archive",
          "guest post", "personal blog", "lifestyle", "travel", "food"
        ]
      },{
        type: "Government Website",
        schema: ["governmentorganization", "governmentservice"],
        keywords: [
          "government", "ministry", "department of", "public services",
          "official website", "gov", "municipal", "citizen",
          "policies", "schemes", "portal", "public", "administration",
          "government of", "national", "state", "local government",
          "public health", "education department", "tax", "e-governance"
        ]
      },{
        type: "Nonprofit Website",
        schema: ["ngo", "nonprofit", "charity"],
        keywords: [
          "nonprofit", "non-profit", "ngo", "charity", "donate",
          "foundation", "volunteer", "fundraising", "mission",
          "cause", "donation", "sponsor", "community", "social work",
          "help", "support", "campaign", "awareness", "change"
        ]
      },

      {
        type: "Crowdfunding Website",
        keywords: [
          "crowdfunding", "back this project", "pledge", "fundraiser",
          "raise funds", "campaign goal", "backers", "support us",
          "donation", "project", "invest", "startup", "creator"
        ]
      },
      {
        type: "Booking Website",
        schema: ["reservation", "lodgingbusiness", "hotel", "traveleagency"],
        keywords: [
          "book now", "booking", "reservation", "flights", "hotels",
          "check-in", "check-out", "travel", "reserve",
          "trip", "vacation", "destination", "accommodation", "rental"
        ]
      },
      {
        type: "Streaming Website",
        keywords: [
          "streaming", "watch online", "live stream", "on-demand",
          "ott", "episodes", "seasons", "stream now",
          "stream", "watch", "vod", "live tv", "entertainment"
        ]
      },
      {
        type: "Entertainment Website",
        keywords: [
          "entertainment", "movies", "music", "games", "gaming",
          "videos", "celebrity", "shows", "fun", "comedy",
          "film", "actor", "album", "concert", "event"
        ]
      },
      {
        type: "Media Sharing Website",
        keywords: [
          "upload", "share photos", "share videos", "media sharing",
          "gallery", "user uploads", "multimedia", "content sharing",
          "image", "video", "file", "storage", "hosting"
        ]
      },{
        type: "Social Media Website",
        schema: ["socialmediaposting"],
        keywords: [
          "social network", "social media", "connect with friends",
          "followers", "share your", "profile", "feed", "timeline",
          "like", "comment", "post", "message", "friend",
          "instagram", "facebook", "twitter", "linkedin", "tiktok"
        ]
      },
      {
        type: "Forum/Community Website",
        schema: ["discussionforumposting"],
        keywords: [
          "forum", "community", "discussion", "threads", "ask a question",
          "replies", "topics", "members online", "moderator",
          "community forum", "discuss", "question", "answer"
        ]
      },
      {
        type: "Wiki Website",
        keywords: [
          "wiki", "edit this page", "knowledge base", "encyclopedia",
          "collaborative", "revision history", "contributors",
          "wikipedia", "information", "reference", "article"
        ]
      },
      {
        type: "Search Engine",
        schema: ["searchaction"],
        keywords: [
          "search engine", "search the web", "web search",
          "search query", "results", "google", "bing", "duckduckgo",
          "search bar", "advanced search", "filter"
        ]
      },
      {
        type: "Documentation Website",
        keywords: [
          "documentation", "docs", "api reference", "developer guide",
          "getting started", "user guide", "sdk", "tutorial",
          "reference", "manual", "faq", "examples", "code"
        ]
      },
      {
        type: "Knowledge Base",
        keywords: [
          "knowledge base", "help center", "support articles",
          "faq", "troubleshooting", "how do i", "support center",
          "knowledge", "solutions", "guides", "articles"
        ]
      },{
        type: "Membership Website",
        keywords: [
          "membership", "members only", "premium content",
          "subscribe to access", "member login", "exclusive content",
          "member", "join", "community", "access", "benefits"
        ]
      },
      {
        type: "Directory Website",
        keywords: [
          "directory", "business listings", "find businesses",
          "listed", "browse categories", "yellow pages",
          "listing", "companies", "reviews", "ratings"
        ]
      },

      {
        type: "Portfolio Website",
        keywords: [
          "portfolio", "my work", "case studies", "projects",
          "showcase", "selected works", "hire me",
          "design", "creative", "work", "client", "project"
        ]
      },   
      {
        type: "Personal Website",
        keywords: [
          "personal website", "about me", "my resume",
          "personal blog", "curriculum vitae", "my portfolio",
          "me", "myself", "introduction", "bio", "profile"
        ]
      },
      {
        type: "Landing Page",
        keywords: [
          "sign up now", "get started", "limited offer",
          "join the waitlist", "coming soon", "lead generation",
          "waitlist", "subscribe", "download", "access now"
        ]
      },
      {
        type: "Web Application",
        schema: ["webapplication"],
        keywords: [
          "dashboard", "crm", "erp", "web app", "login to your account",
          "workspace", "admin panel", "task management",
          "application", "tool", "productivity", "automation"
        ]
      },
      {
        type: "Business/Corporate Website",
        keywords: [
          "our services", "about us", "company", "solutions",
          "consulting", "agency", "our team", "contact us",
          "enterprise", "corporation", "business", "partnership",
          "clients", "expertise", "years of experience", "service"
        ]
      }
    ];

    const scores = {};
    for (const def of typeDefinitions) {
      let score = 0;
      if (def.schema) {
        for (const s of def.schema) {
          if (schemaTypes.includes(s)) score += 5;
        }
      }
      if (def.keywords) {
        for (const kw of def.keywords) {
          if (classifyText.includes(kw)) score += 1;
        }
      }
      if (score > 0) scores[def.type] = score;
    }

    const bestType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const keywordScore = bestType ? bestType[1] : 0;
    const hasStrongKeywordSignal = Boolean(bestType && keywordScore >= 3);

    if (hasStrongKeywordSignal) {
      metadata.company_type = bestType[0];
      metadata.company_type_source = "keywords";
    } else {
      metadata.company_type = bestType
        ? bestType[0]
        : "Business/Corporate Website";
      metadata._needsLlamaTypeClassification = true;
      metadata._schemaTypes = schemaTypes;
    }

    const industryKeywords = {
      technology: ["tech", "software", "it", "saas", "platform"],
      healthcare: ["health", "medical", "hospital", "clinic", "wellness"],
      "real estate": ["real estate", "property", "realty", "housing", "realty"],
      finance: ["finance", "financial", "banking", "investment", "fintech"],
      education: ["education", "learning", "school", "university", "course"],
      retail: ["retail", "store", "shop", "e-commerce", "shopping"],
    };

    for (const [industry, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some((keyword) => combinedText.includes(keyword))) {
        metadata.industry = industry;
        break;
      }
    }

    // Extract founded year from footer or content
    const footerText = $("footer").text();
    const bodyText = $("body").text();
    const yearMatch = (footerText + " " + bodyText).match(
      /(?:founded|established|since|©)\s*(?:in\s*)?(\d{4})/i,
    );
    if (yearMatch) {
      metadata.founded_year = yearMatch[1];
    }

    // Extract services from navigation, services section, or meta tags
    const services = new Set();

    // Check navigation links
    $("nav a, header a").each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if (
        text &&
        !text.match(/^(home|about|contact|blog|login|sign up|sign in)$/i)
      ) {
        if (text.length < 50) {
          // Reasonable service name length
          services.add($(el).text().trim());
        }
      }
    });

    // Check for services section
    $(
      '[class*="service"], [id*="service"], [class*="product"], [id*="product"]',
    ).each((_, el) => {
      const text = $(el).text().trim();
      const headings = $(el)
        .find("h2, h3, h4")
        .map((_, h) => $(h).text().trim())
        .get();
      headings.forEach((heading) => {
        if (heading.length < 50 && heading.length > 3) {
          services.add(heading);
        }
      });
    });

    metadata.services_list = Array.from(services).slice(0, 10); // Limit to 10 services

    // Extract value proposition from meta description or hero section
    const metaDesc = $('meta[name="description"]').attr("content")?.trim();
    const heroText = $(
      '[class*="hero"], [class*="banner"], [class*="headline"]',
    )
      .first()
      .text()
      .trim();

    metadata.value_proposition = metaDesc || heroText.substring(0, 200) || "";

    // Extract "does not" list - this is harder to extract automatically
    // We'll leave it empty for now, can be manually filled or enhanced later
    metadata.does_not_list = [];

    // Detect website language from HTML signals and body text
    const langInfo = detectWebsiteLanguage($, bodyText.trim());
    metadata.primary_language = langInfo.primary_language;
    metadata.languages = langInfo.languages;
    metadata.language_confidence = langInfo.language_confidence;
    metadata.language_source = langInfo.language_source;
  } catch (error) {
    console.error("Error extracting website metadata:", error);
  }

  return metadata;
};

const processWebPage = async (url, sourceCode, footerCache = {}) => {
  try {
    const $ = cheerio.load(sourceCode);
    const webPageURL = url;
    const domain = new URL(webPageURL).hostname;

    // ---- Metadata ----
    const title = $("title").text().trim() || webPageURL;
    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || "";

    // ---- Remove unwanted elements ----
    $(
      "script, style, noscript, iframe, svg, canvas, form, input, button, select, textarea",
    ).remove();
    $(".ad, .advertisement, .popup, .modal").remove();

    // ---- Handle footer: scrape once per domain ----
    let footerHTML = "";
    const footer = $("footer").first();

    if (footer.length) {
      const footerText = footer.text().trim();
      if (footerText && !footerCache[domain]) {
        footerCache[domain] = true; // mark as processed
        footerHTML = footer.html();
      }
      footer.remove(); // remove footer from page to prevent duplication
    }

    // ---- Convert relative URLs ----
    $("a, img").each((_, el) => {
      const attr = $(el).is("a") ? "href" : "src";
      const val = $(el).attr(attr);
      if (val && !val.startsWith("http") && !val.startsWith("data:")) {
        $(el).attr(attr, urlModule.resolve(webPageURL, val));
      }
    });

    // ---- Convert images to descriptive text ----
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      const alt = $(el).attr("alt")?.trim();
      if (src) {
        const altText = alt ? ` (${alt})` : "";
        $(el).replaceWith(`<p>Image${altText}: ${src}</p>`);
      }
    });

    // ---- Convert anchor-only links ----
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && !text) {
        $(el).text(`Link: ${href}`);
      }
    });

    // ---- Remove empty or redundant tags ----
    $("*").each((_, el) => {
      const text = $(el).text().trim();
      if (!text && $(el).children().length === 0) {
        $(el).remove();
      }
    });

    // ---- Convert to Markdown ----
    const turndownService = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
    });

    let markdown = turndownService.turndown($("body").html() || "");

    // Append footer content once per domain
    if (footerHTML) {
      const enrichedFooter = enrichFooterHtml(footerHTML);
      const footerMarkdown = turndownService.turndown(enrichedFooter);
      markdown += `\n\n---\n**Footer Links (from ${domain})**\n${footerMarkdown}`;
    }

    // ---- Clean whitespace (preserve structure) ----
    // Replace multiple spaces with single space, but preserve newlines
    const cleanContent = markdown
      .replace(/[ \t]+/g, " ") // Replace multiple spaces/tabs with single space
      .replace(/\n{3,}/g, "\n\n") // Replace 3+ newlines with double newline
      .trim();

    // Extract website metadata (from homepage-like URLs or we'll extract from first URL)
    let websiteMetadata = null;
    const urlPath = new URL(url).pathname;
    const isHomepage = urlPath === "/" || urlPath === "";

    // Always extract metadata (we'll decide whether to use it based on homepage status)
    const $meta = cheerio.load(sourceCode);
    websiteMetadata = extractWebsiteMetadata($meta, url, { isHomepage });

    if (websiteMetadata?._needsLlamaTypeClassification) {
      const llamaType = await classifyWebsiteType({
        url,
        title,
        description: metaDescription,
        pageContent: cleanContent,
        schemaTypes: websiteMetadata._schemaTypes || [],
      });

      if (llamaType?.company_type) {
        websiteMetadata.company_type = llamaType.company_type;
        websiteMetadata.company_type_source = llamaType.source;
        if (llamaType.industry && !websiteMetadata.industry) {
          websiteMetadata.industry = llamaType.industry;
        }
      }

      delete websiteMetadata._needsLlamaTypeClassification;
      delete websiteMetadata._schemaTypes;
    }

    // Mark if this is homepage for priority
    if (isHomepage) {
      websiteMetadata._isHomepage = true;
    }

    return {
      content: cleanContent,
      webPageURL,
      title,
      metaDescription,
      websiteMetadata, // Include metadata if this is homepage
    };
  } catch (error) {
    console.error("Error processing webpage:", error);
    return null;
  }
};

const planUpgradeQueue = new Queue("planUpgradeQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

// Create the worker with error handling
new Worker(
  "planUpgradeQueue",
  async (job) => {
    const { userId, sourceCollection, targetCollection } = job.data;

    try {
      console.log(`Processing plan upgrade for user: ${userId}`);
      //   await PlanService.migrateFreeUserData(userId);
      const TrainingListFreeUsers = require("../models/TrainingListFreeUsers");
      const TrainingList = require("../models/OpenaiTrainingList");

      const freeUserData = await TrainingListFreeUsers.find({ userId });

      for (const item of freeUserData) {
        const newItem = new TrainingList(item.toObject());
        newItem._id = undefined; // Let MongoDB generate new ID
        await newItem.save();
      }

      const qdrantManager = new QdrantVectorStoreManager(sourceCollection);
      await qdrantManager.migrateCollection(sourceCollection, targetCollection);

      console.log(`Plan upgrade completed for user: ${userId}`);
    } catch (error) {
      console.error(`Plan upgrade failed for user ${userId}:`, error);
      throw error; // Re-throw to mark job as failed
    }
  },
  {
    connection: redisConfig,
    concurrency: 2, // Limit concurrent processing
  },
);

const urlProcessingQueue = new Queue("urlProcessingQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 5,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
  },
});

new Worker(
  "urlProcessingQueue",
  async (job) => {
    const {
      urls,
      userId,
      agentId,
      qdrantIndexName,
      plan,
      sitemapUrl,
      startTime,
      totalUrls,
    } = job.data;
    try {
      const batchService = new batchTrainingService();

      const TrainingListFreeUsers = require("../models/TrainingListFreeUsers");
      const TrainingList = require("../models/OpenaiTrainingList");
      let TrainingModel = TrainingListFreeUsers;
      if (plan.name === "free") {
        TrainingModel = TrainingListFreeUsers;
      } else {
        TrainingModel = TrainingList;
      }

      let scrapedDocs = [];
      let currentDataSize = 0;
      const footerCache = {};
      let metadataExtracted = false; // Track if metadata has been extracted
      let metadataFromHomepage = false;
      let stoppedForStorageLimit = false;
      let storageLimitEmitMessage = null;
      let storageLimitEmitProgress = null;

      // Use startTime from job data or current time as fallback
      const scrapingStartTime = startTime ? new Date(startTime) : new Date();
      const totalUrlsCount = totalUrls || urls.length;
      let lastProgressEmitTime = Date.now();
      const PROGRESS_EMIT_INTERVAL = 2000; // Emit progress every 2 seconds

      const emitScrapingProgress = async (
        currentIndex,
        totalCount,
        isProcessing = true,
      ) => {
        const scrapingProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "scraping",
          processed: currentIndex,
          total: totalCount,
          isProcessing,
        });

        await job.updateProgress({
          phase: "scraping",
          scrapeCurrent: currentIndex,
          scrapeTotal: totalCount,
        });

        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress,
        });
      };

      let lastTrainingEmitTime = 0;
      const emitTrainingProgress = async ({
        trainingProcessed,
        trainingTotal,
        embeddingProgress = 0,
        embeddingTotal = 0,
        upsertProgress = 0,
        upsertTotal = 0,
        trainingStep = "chunking",
        force = false,
      }) => {
        const now = Date.now();
        if (!force && now - lastTrainingEmitTime < PROGRESS_EMIT_INTERVAL) {
          return;
        }
        lastTrainingEmitTime = now;

        const scrapingProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "training",
          processed: totalUrlsCount,
          total: totalUrlsCount,
          trainingStep,
          trainingProcessed,
          trainingTotal,
          embeddingProgress,
          embeddingTotal,
          upsertProgress,
          upsertTotal,
          isProcessing: true,
        });

        await job.updateProgress({
          phase: "training",
          scrapeCurrent: totalUrlsCount,
          scrapeTotal: totalUrlsCount,
          trainingCurrent: trainingProcessed,
          trainingTotal,
          trainingStep,
          embeddingProgress,
          embeddingTotal,
          upsertProgress,
          upsertTotal,
        });

        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress,
        });
      };

      // Emit initial progress
      await emitScrapingProgress(0, totalUrlsCount, true);

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          console.log("Processing URL :", url);

          if (!isScrapableWebUrl(url)) {
            console.log(`Skipping non-HTML URL: ${url}`);
            await markWebUrlScrapeFailed({
              url,
              userId,
              agentId,
              TrainingModel,
              error: NON_HTML_SKIP_ERROR,
            });
            continue;
          }

          // Emit progress updates periodically (every 2 seconds or every URL)
          const now = Date.now();
          if (
            now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
            i === 0 ||
            i === urls.length - 1
          ) {
            await emitScrapingProgress(i + 1, totalUrlsCount, true);
            lastProgressEmitTime = now;
          }

          const response = await axios.get(url, {
            timeout: 30000, // 30 second timeout
            maxContentLength: 50 * 1024 * 1024, // 50MB max
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
            },
          });

          const contentType = response.headers?.["content-type"] || "";
          if (!isHtmlContentType(contentType)) {
            console.log(
              `Skipping non-HTML response for ${url}: ${contentType || "unknown"}`,
            );
            await markWebUrlScrapeFailed({
              url,
              userId,
              agentId,
              TrainingModel,
              error: NON_HTML_SKIP_ERROR,
            });
            continue;
          }

          const sourceCode = response?.data;

          if (typeof sourceCode !== "string") {
            await markWebUrlScrapeFailed({
              url,
              userId,
              agentId,
              TrainingModel,
              error: "Response is not HTML text content",
            });
            continue;
          }

          const processResult = await processWebPage(
            url,
            sourceCode,
            footerCache,
          );
          if (!processResult.content) {
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: "",
              dataSize: 0,
              trainingStatus: 2,
              error: "No data found",
              "webPage.url": url,
              chunkCount: 0,
              lastEdit: Date.now(),
            });
            await Url.updateOne(
              { url: url, agentId: agentId },
              {
                $set: {
                  trainStatus: 2,
                  error: "Failed to process/minify web page content",
                },
              },
            );
            continue;
          }

          const {
            content,
            title,
            metaDescription,
            webPageURL,
            websiteMetadata,
          } = processResult;

          // Store website metadata if extracted
          // Priority: homepage always wins; otherwise use first URL (domain-based name)
          if (websiteMetadata) {
            const isHome = websiteMetadata._isHomepage === true;
            const shouldStore =
              isHome || (!metadataExtracted && !metadataFromHomepage);

            if (shouldStore) {
              try {
                let websiteData = await WebsiteData.getOrCreate({
                  userId,
                  ...(agentId ? { agentId } : {}),
                });
                // Remove internal flag before storing
                const { _isHomepage, ...cleanMetadata } = websiteMetadata;
                await websiteData.updateData({
                  ...cleanMetadata,
                  website_url: cleanMetadata.website_url || url,
                  domain: cleanMetadata.domain || new URL(url).hostname,
                });
                metadataExtracted = true;
                if (isHome) metadataFromHomepage = true;
                console.log(
                  `[jobService] Stored website metadata for user ${userId} from ${url}`,
                );
              } catch (metadataError) {
                console.error(
                  `[jobService] Error storing website metadata:`,
                  metadataError,
                );
                // Don't fail the job if metadata storage fails
              }
            }
          }

          const contentSize = Buffer.byteLength(content, "utf8");

          let clientDoc = await Client.findOne({ userId });
          currentDataSize = clientDoc?.currentDataSize || 0;
          const maxStorage =
            clientDoc.customLimits?.isCustomLimits &&
            clientDoc.customLimits?.maxStorage != null
              ? clientDoc.customLimits.maxStorage
              : plan.limits.maxStorage;

          console.log("clientDoc", clientDoc);

          console.log("max storage is", maxStorage);
          console.log(
            "current data size + content size ",
            currentDataSize + contentSize,
          );
          // if (currentDataSize + contentSize > plan.limits.maxStorage) {
          if (currentDataSize + contentSize > maxStorage) {


            console.log("storage limit exceeded");
            await Client.updateOne(
              { userId },
              { $set: { "upgradePlanStatus.storageLimitExceeded": true } },
            );

            // Emit progress before stopping due to storage limit
            const storageLimitElapsedTime = Math.floor(
              (Date.now() - scrapingStartTime.getTime()) / 1000,
            );
            const formatTimeForLimit = (seconds) => {
              const hrs = Math.floor(seconds / 3600);
              const mins = Math.floor((seconds % 3600) / 60);
              const secs = seconds % 60;
              return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
            };

            storageLimitEmitMessage =
              "Storage limit exceeded. Scraping stopped. Upgrade your plan to continue.";
            storageLimitEmitProgress = {
              percentage:
                totalUrlsCount > 0
                  ? Math.round(((i + 1) / totalUrlsCount) * 100)
                  : 0,
              processed: i + 1,
              total: totalUrlsCount,
              elapsedTime: formatTimeForLimit(storageLimitElapsedTime),
              elapsedSeconds: storageLimitElapsedTime,
              estimatedTimeRemaining: null,
              estimatedSecondsRemaining: null,
              isProcessing: false,
              stoppedReason: "storage_limit_exceeded",
            };
            stoppedForStorageLimit = true;

            appEvents.emit("userEvent", agentId, "training-event", {
              agent: await Agent.findOne({ _id: agentId }),
              client: await Client.findOne({ userId }),
              message: storageLimitEmitMessage,
              scrapingProgress: storageLimitEmitProgress,
            });
            break;
          } else {
            await Client.updateOne(
              { userId },
              { $inc: { currentDataSize: contentSize } },
            );

            scrapedDocs.push({
              type: 0,
              content,
              dataSize: contentSize,
              metadata: {
                url: webPageURL,
                title,
                metaDescription,
                type: "webpage",
              },
              originalUrl: url,
            });
          }
        } catch (error) {
          // Upsert so every scrape failure appears in the training list (find-only updates missed new URLs).
          const existingFailRow = await TrainingModel.findOne({
            userId,
            agentId,
            "webPage.url": url,
          })
            .select("trainingStatus")
            .lean();
          const prevTrainStatus = existingFailRow?.trainingStatus;

          await TrainingModel.findOneAndUpdate(
            { userId, agentId, "webPage.url": url },
            {
              $set: {
                userId,
                agentId,
                type: 0,
                trainingStatus: 2,
                lastEdit: Date.now(),
                error: error?.message,
                "webPage.url": url,
              },
            },
            { upsert: true, setDefaultsOnInsert: true }
          );

          if (prevTrainStatus !== 2) {
            const inc =
              prevTrainStatus === 1
                ? { "pagesAdded.success": -1, "pagesAdded.failed": 1 }
                : { "pagesAdded.failed": 1 };
            await Agent.updateOne({ _id: agentId }, { $inc: inc });
          }
          await Url.updateOne(
            { url: url, agentId: agentId },
            {
              $set: {
                trainStatus: 2,
                error: "Failed to train",
              },
            },
          );
        }
      }

      if (!stoppedForStorageLimit) {
        await emitScrapingProgress(urls.length, totalUrlsCount, true);

        if (scrapedDocs.length > 0) {
          await emitTrainingProgress({
            trainingProcessed: 0,
            trainingTotal: scrapedDocs.length,
            force: true,
          });
        }
      }

      //make this a queue
      let result = await batchService.processDocumentAndTrain(
        scrapedDocs,
        userId,
        agentId,
        qdrantIndexName,
        {
          onProgress: async (progress) => {
            if (stoppedForStorageLimit) return;
            await emitTrainingProgress({
              trainingProcessed: progress.trainingProcessed,
              trainingTotal: progress.trainingTotal,
              embeddingProgress: progress.embeddingProgress ?? 0,
              embeddingTotal: progress.embeddingTotal ?? 0,
              upsertProgress: progress.upsertProgress ?? 0,
              upsertTotal: progress.upsertTotal ?? 0,
              trainingStep: progress.step ?? "chunking",
              force:
                progress.step === "embedding" || progress.step === "upserting",
            });
          },
        },
      );

      // Handle training failure
      if (!result.success) {
        // Mark all documents as failed if training failed
        await Agent.updateOne(
          { _id: agentId },
          { $set: { dataTrainingStatus: 0 } },
        );
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          message: error?.message,
        });
      } else {
        // 3️⃣ Update training status in DB
        for (const doc of scrapedDocs) {
          const status = result?.failedUrls?.includes(doc.originalUrl) ? 2 : 1;
          if (status == 1) {
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: doc.content,
              dataSize: doc.dataSize,
              trainingStatus: status,
              "webPage.url": doc.originalUrl,
              chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
              lastEdit: Date.now(),
            });
          } else if (status == 2) {
            await TrainingModel.create({
              userId,
              agentId,
              type: 0,
              content: doc.content,
              dataSize: doc.dataSize,
              trainingStatus: status,
              error: "Failed to process/minify web page content",
              "webPage.url": doc.originalUrl,
              chunkCount: result.chunkCountPerUrl?.[doc.originalUrl] || 0,
              lastEdit: Date.now(),
            });
            await Url.updateOne(
              { url: doc.originalUrl, agentId: agentId },
              {
                $set: {
                  trainStatus: status,
                  error: "Failed to process/minify web page content",
                },
              },
            );
          } else {
            await Url.updateOne(
              { url: doc.originalUrl, agentId: agentId },
              {
                $set: {
                  trainStatus: status,
                  // error: "Failed to process/minify web page content",
                },
              },
            );
          }

          await Agent.updateOne(
            { _id: agentId },
            {
              $inc: {
                ...(status === 1
                  ? { "pagesAdded.success": 1 }
                  : { "pagesAdded.failed": 1 }),
              },
            },
          );
        }

        if (sitemapUrl) {
          await Agent.updateOne(
            { _id: agentId },
            { $set: { isSitemapAdded: 1 } },
          );
        }
      }

      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 0,
            scrapingStartTime: null,
            lastTrained: new Date(),
          },
        },
      );

      if (stoppedForStorageLimit && storageLimitEmitProgress) {
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          client: await Client.findOne({ userId }),
          message: storageLimitEmitMessage,
          scrapingProgress: storageLimitEmitProgress,
        });
      } else {
        const trainTotal = scrapedDocs.length || totalUrlsCount;
        const finalProgress = buildTrainingProgressPayload({
          startTime: scrapingStartTime,
          phase: "training",
          processed: totalUrlsCount,
          total: totalUrlsCount,
          trainingStep: "upserting",
          trainingProcessed: trainTotal,
          trainingTotal: trainTotal,
          embeddingProgress: trainTotal,
          embeddingTotal: trainTotal,
          upsertProgress: trainTotal,
          upsertTotal: trainTotal,
          isProcessing: false,
        });
        appEvents.emit("userEvent", agentId, "training-event", {
          agent: await Agent.findOne({ _id: agentId }),
          scrapingProgress: finalProgress,
        });
      }
    } catch (error) {
      await Agent.updateOne(
        { _id: agentId },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );

      // Calculate progress even on error
      const errorElapsedTime = Math.floor(
        (Date.now() - scrapingStartTime.getTime()) / 1000,
      );
      const formatTime = (seconds) => {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      };

      // Try to get current progress from URL count
      const processedCount = await Url.countDocuments({
        userId,
        agentId: agentId,
        trainStatus: { $in: [1, 2] },
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
        scrapingProgress: {
          percentage:
            totalUrlsCount > 0
              ? Math.round((processedCount / totalUrlsCount) * 100)
              : 0,
          processed: processedCount,
          total: totalUrlsCount,
          elapsedTime: formatTime(errorElapsedTime),
          elapsedSeconds: errorElapsedTime,
          estimatedTimeRemaining: null,
          estimatedSecondsRemaining: null,
          isProcessing: false,
          error: true,
        },
      });
      console.log(error);
    }
  },
  { connection: redisConfig, concurrency: 3 },
);

// Delete training data queue - runs in background
const deleteTrainingDataQueue = new Queue("deleteTrainingDataQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "deleteTrainingDataQueue",
  async (job) => {
    const { entries, userId, agentId, qdrantIndexName, TrainingModelName } =
      job.data;
    const QdrantVectorStoreManager = require("./QdrantService");
    const PlanService = require("./PlanService");
    const Client = require("../models/Client");
    const Agent = require("../models/Agent");
    const appEvents = require("../events");

    try {
      const TrainingModel =
        TrainingModelName === "TrainingListFreeUsers"
          ? require("../models/TrainingListFreeUsers")
          : require("../models/OpenaiTrainingList");

      let totalDataSizeRemoved = 0;
      let pagesSuccessDeleted = 0;
      let pagesFailedDeleted = 0;
      let filesDeleted = 0;
      let faqsDeleted = 0;

      // Delete vectors from Qdrant
      const qdrantResult =
        await QdrantVectorStoreManager.deleteVectorsByTrainingEntries(
          qdrantIndexName,
          entries.map((e) => ({
            userId: e.userId?.toString(),
            agentId: e.agentId?.toString(),
            type: e.type,
            url: e.webPage?.url,
            title: e.title,
          })),
        );

      if (qdrantResult.errors?.length > 0) {
        console.warn(
          "[deleteTrainingData] Qdrant delete warnings:",
          qdrantResult.errors,
        );
      }

      // Delete from MongoDB and aggregate stats
      for (const entry of entries) {
        await TrainingModel.deleteOne({ _id: entry._id });
        totalDataSizeRemoved += entry.dataSize || 0;
        if (entry.type === 0) {
          if (entry.trainingStatus === 1) pagesSuccessDeleted++;
          else pagesFailedDeleted++;
        } else if (entry.type === 1) filesDeleted++;
        else if (entry.type === 3) faqsDeleted++;
      }

      // Update Client currentDataSize
      // await Client.updateOne(
      //   { userId },
      //   { $inc: { currentDataSize: -Math.max(0, totalDataSizeRemoved) } }
      // );

      // Update Agent counters
      const updateFields = {};
      if (pagesSuccessDeleted > 0)
        updateFields["pagesAdded.success"] = -pagesSuccessDeleted;
      if (pagesFailedDeleted > 0)
        updateFields["pagesAdded.failed"] = -pagesFailedDeleted;
      if (pagesSuccessDeleted > 0 || pagesFailedDeleted > 0) {
        updateFields["pagesAdded.total"] = -(
          pagesSuccessDeleted + pagesFailedDeleted
        );
      }
      if (filesDeleted > 0) updateFields.filesAdded = -filesDeleted;
      if (faqsDeleted > 0) updateFields.faqsAdded = -faqsDeleted;
      if (Object.keys(updateFields).length > 0) {
        await Agent.updateOne({ _id: agentId }, { $inc: updateFields });
      }

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      console.log(
        `[deleteTrainingData] Deleted ${entries.length} training entries for user ${userId}`,
      );
    } catch (error) {
      console.error("[deleteTrainingData] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
);

// Retrain training data queue - only webpages (type 0)
const retrainTrainingDataQueue = new Queue("retrainTrainingDataQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "retrainTrainingDataQueue",
  async (job) => {
    const {
      entries,
      userId,
      agentId,
      qdrantIndexName,
      TrainingModelName,
      startTime,
      totalEntries: jobTotalEntries,
    } = job.data;
    const batchService = new batchTrainingService();
    const Agent = require("../models/Agent");

    const TrainingModel =
      TrainingModelName === "TrainingListFreeUsers"
        ? require("../models/TrainingListFreeUsers")
        : require("../models/OpenaiTrainingList");

    const retrainStartTime = startTime ? new Date(startTime) : new Date();
    const validEntries = (entries || []).filter((e) => e.webPage?.url);
    const totalEntries = jobTotalEntries || validEntries.length;
    let lastProgressEmitTime = Date.now();
    const PROGRESS_EMIT_INTERVAL = 2000;
    let lastTrainingEmitTime = 0;
    let processedCount = 0;

    const emitScrapingProgress = async (
      currentIndex,
      totalCount,
      isProcessing = true,
    ) => {
      const scrapingProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        phase: "scraping",
        processed: currentIndex,
        total: totalCount,
        isProcessing,
      });

      await job.updateProgress({
        phase: "scraping",
        scrapeCurrent: currentIndex,
        scrapeTotal: totalCount,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress,
      });
    };

    const emitTrainingProgress = async ({
      trainingProcessed,
      trainingTotal,
      embeddingProgress = 0,
      embeddingTotal = 0,
      upsertProgress = 0,
      upsertTotal = 0,
      trainingStep = "chunking",
      force = false,
    }) => {
      const now = Date.now();
      if (!force && now - lastTrainingEmitTime < PROGRESS_EMIT_INTERVAL) {
        return;
      }
      lastTrainingEmitTime = now;

      const scrapingProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        phase: "training",
        processed: totalEntries,
        total: totalEntries,
        trainingStep,
        trainingProcessed,
        trainingTotal,
        embeddingProgress,
        embeddingTotal,
        upsertProgress,
        upsertTotal,
        isProcessing: true,
      });

      await job.updateProgress({
        phase: "training",
        scrapeCurrent: totalEntries,
        scrapeTotal: totalEntries,
        trainingCurrent: trainingProcessed,
        trainingTotal,
        trainingStep,
        embeddingProgress,
        embeddingTotal,
        upsertProgress,
        upsertTotal,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress,
      });
    };

    try {
      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 1,
            scrapingStartTime: retrainStartTime,
          },
        },
      );
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
      });

      const footerCache = {};
      const pendingRetrainItems = [];
      const qdrantManager = new QdrantVectorStoreManager(qdrantIndexName);
      let successCount = 0;
      let failCount = 0;

      async function applyWebPagePagesAddedDelta(prevStatus, newStatus) {
        if (prevStatus === newStatus) return;
        const inc = {};
        if (prevStatus === 1) inc["pagesAdded.success"] = -1;
        else if (prevStatus === 2) inc["pagesAdded.failed"] = -1;
        if (newStatus === 1) inc["pagesAdded.success"] = (inc["pagesAdded.success"] || 0) + 1;
        else if (newStatus === 2) inc["pagesAdded.failed"] = (inc["pagesAdded.failed"] || 0) + 1;
        const filtered = Object.fromEntries(Object.entries(inc).filter(([, v]) => v !== 0));
        if (Object.keys(filtered).length === 0) return;
        await Agent.updateOne({ _id: agentId }, { $inc: filtered });
      }

      const markEntryFailed = async ({ entry, prevStatus, error }) => {
        await TrainingModel.updateOne(
          { _id: entry._id },
          {
            $set: {
              trainingStatus: 2,
              error,
              lastEdit: new Date(),
            },
          },
        );
        await applyWebPagePagesAddedDelta(prevStatus, 2);
        failCount++;
      };

      const markEntryFailedAndContinue = async (args) => {
        await markEntryFailed(args);
        processedCount++;
        await emitScrapingProgress(
          processedCount,
          totalEntries,
          processedCount < totalEntries,
        );
      };

      await emitScrapingProgress(0, totalEntries, true);

      for (let i = 0; i < validEntries.length; i++) {
        const entry = validEntries[i];
        const url = entry.webPage.url;
        const prevStatus = entry.trainingStatus;

        const now = Date.now();
        if (
          now - lastProgressEmitTime >= PROGRESS_EMIT_INTERVAL ||
          i === 0 ||
          i === validEntries.length - 1
        ) {
          await emitScrapingProgress(processedCount, totalEntries, true);
          lastProgressEmitTime = now;
        }

        try {
          if (!isScrapableWebUrl(url)) {
            console.log(`[retrainTrainingData] Skipping non-HTML URL: ${url}`);
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: NON_HTML_SKIP_ERROR,
            });
            continue;
          }

          const deleteResult = await qdrantManager.deleteByFields({
            user_id: userId?.toString(),
            agent_id: agentId?.toString(),
            url,
          });
          if (!deleteResult.success) {
            throw new Error(
              `Failed to delete old vectors: ${deleteResult.error}`,
            );
          }

          const response = await axios.get(url, {
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024,
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; WebScraper/1.0)",
            },
          });

          const contentType = response.headers?.["content-type"] || "";
          if (!isHtmlContentType(contentType)) {
            console.log(
              `[retrainTrainingData] Skipping non-HTML response for ${url}: ${contentType || "unknown"}`,
            );
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: NON_HTML_SKIP_ERROR,
            });
            continue;
          }

          if (typeof response?.data !== "string") {
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: "Response is not HTML text content",
            });
            continue;
          }

          const processResult = await processWebPage(
            url,
            response.data,
            footerCache,
          );

          if (!processResult?.content) {
            await markEntryFailedAndContinue({
              entry,
              prevStatus,
              error: "Failed to process/minify web page content",
            });
            continue;
          }

          const { content, title, metaDescription, webPageURL } = processResult;
          const contentSize = Buffer.byteLength(content, "utf8");
          const oldDataSize = entry.dataSize || 0;
          const dataSizeDelta = contentSize - oldDataSize;

          pendingRetrainItems.push({
            entry,
            prevStatus,
            url,
            content,
            contentSize,
            dataSizeDelta,
            scrapedDoc: {
              type: 0,
              content,
              dataSize: contentSize,
              metadata: {
                url: webPageURL,
                title,
                metaDescription,
                type: "webpage",
              },
              originalUrl: url,
            },
          });

          processedCount++;
          await emitScrapingProgress(
            processedCount,
            totalEntries,
            processedCount < totalEntries,
          );
        } catch (err) {
          console.error(`[retrainTrainingData] Error retraining ${url}:`, err);
          await markEntryFailedAndContinue({
            entry,
            prevStatus,
            error: err?.message || "Scraping failed",
          });
        }
      }

      if (pendingRetrainItems.length > 0) {
        await emitTrainingProgress({
          trainingProcessed: 0,
          trainingTotal: pendingRetrainItems.length,
          force: true,
        });

        const result = await batchService.processDocumentAndTrain(
          pendingRetrainItems.map((item) => item.scrapedDoc),
          userId,
          agentId,
          qdrantIndexName,
          {
            onProgress: async (progress) => {
              await emitTrainingProgress({
                trainingProcessed: progress.trainingProcessed ?? 0,
                trainingTotal:
                  progress.trainingTotal ?? pendingRetrainItems.length,
                embeddingProgress: progress.embeddingProgress ?? 0,
                embeddingTotal: progress.embeddingTotal ?? 0,
                upsertProgress: progress.upsertProgress ?? 0,
                upsertTotal: progress.upsertTotal ?? 0,
                trainingStep: progress.step ?? "chunking",
                force:
                  progress.step === "embedding" ||
                  progress.step === "upserting",
              });
            },
          },
        );

        if (!result.success) {
          for (const item of pendingRetrainItems) {
            await markEntryFailed({
              entry: item.entry,
              prevStatus: item.prevStatus,
              error: result.error || "Failed to upsert vectors",
            });
          }
        } else {
          for (const item of pendingRetrainItems) {
            const failed = result.failedUrls?.includes(item.url);
            if (failed) {
              await markEntryFailed({
                entry: item.entry,
                prevStatus: item.prevStatus,
                error: "Failed to upsert vectors",
              });
              continue;
            }

            await TrainingModel.updateOne(
              { _id: item.entry._id },
              {
                $set: {
                  content: item.content,
                  dataSize: item.contentSize,
                  trainingStatus: 1,
                  lastEdit: new Date(),
                  chunkCount: result.chunkCountPerUrl?.[item.url] || 0,
                  "webPage.url": item.url,
                },
              },
            );

            await applyWebPagePagesAddedDelta(item.prevStatus, 1);

            if (item.dataSizeDelta !== 0) {
              await Client.updateOne(
                { userId },
                { $inc: { currentDataSize: item.dataSizeDelta } },
              );
            }

            successCount++;
          }
        }
      }

      await emitScrapingProgress(totalEntries, totalEntries, false);

      await Agent.updateOne(
        { _id: agentId },
        {
          $set: {
            dataTrainingStatus: 0,
            scrapingStartTime: null,
            lastTrained: new Date(),
          },
        },
      );

      const finalProgress = buildTrainingProgressPayload({
        startTime: retrainStartTime,
        phase: "training",
        processed: totalEntries,
        total: totalEntries,
        trainingStep: "upserting",
        trainingProcessed: totalEntries,
        trainingTotal: totalEntries,
        embeddingProgress: totalEntries,
        embeddingTotal: totalEntries,
        upsertProgress: totalEntries,
        upsertTotal: totalEntries,
        isProcessing: false,
      });

      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        scrapingProgress: finalProgress,
      });

      console.log(
        `[retrainTrainingData] Completed: ${successCount} success, ${failCount} failed for user ${userId}`,
      );
    } catch (error) {
      console.error("[retrainTrainingData] Job failed:", error);
      await Agent.updateOne(
        { _id: agentId },
        { $set: { dataTrainingStatus: 0, scrapingStartTime: null } },
      );
      appEvents.emit("userEvent", agentId, "training-event", {
        agent: await Agent.findOne({ _id: agentId }),
        message: error?.message,
      });
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
);

const transcriptEmailQueue = new Queue("transcriptEmailQueue", {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

new Worker(
  "transcriptEmailQueue",
  async (job) => {
    const { conversation } = job.data || {};
    try {
      if (!conversation?._id || !conversation?.userId) {
        console.warn(
          "[transcriptEmailQueue] Missing conversation data, skipping job",
        );
        return;
      }

      const {
        sendConversationTranscriptEmail,
      } = require("../helpers/visitorHandlers");
      await sendConversationTranscriptEmail(conversation);
      console.log(
        `[transcriptEmailQueue] Transcript email sent for conversation ${conversation._id}`,
      );
    } catch (error) {
      console.error("[transcriptEmailQueue] Job failed:", error);
      throw error;
    }
  },
  { connection: redisConfig, concurrency: 2 },
);

module.exports = {
  planUpgradeQueue,
  urlProcessingQueue,
  deleteTrainingDataQueue,
  retrainTrainingDataQueue,
  transcriptEmailQueue,
};
