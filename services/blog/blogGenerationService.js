const { OpenAI } = require("openai");
const { getResolvedModelConfig } = require("../aiModelService");

let openai = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the server");
  }
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

function normalizeGeneratedBlog(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid blog generation response");
  }

  const title = String(data.title || "").trim();
  const content = sanitizeHtml(String(data.content || ""));
  const excerpt = String(data.excerpt || "").trim();
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : [];
  const metaTitle = String(data.metaTitle || title).trim();
  const metaDescription = String(data.metaDescription || excerpt).trim();

  if (!title || !content) {
    throw new Error("Generated blog is missing title or content");
  }

  return { title, content, excerpt, tags, metaTitle, metaDescription };
}

/**
 * Generate a structured HTML blog post from a topic using OpenAI JSON mode.
 */
async function generateBlogFromTopic({
  topic,
  tone = "Professional",
  language = "English",
  length = "1500 words",
}) {
  if (!topic || !String(topic).trim()) {
    throw new Error("Blog topic is required");
  }
  const client = getOpenAIClient();

  let modelName =
    process.env.OPENAI_CHAT_MODEL ||
    process.env.OPENAI_CHAT_MODEL_PREMIUM ||
    "gpt-4.1-mini";

  try {
    const cfg = await getResolvedModelConfig("chat");
    if (cfg?.model) modelName = cfg.model;
  } catch {
    // use env fallback
  }

  const systemPrompt = `You are an expert blog writer for e-commerce and business websites.
Return ONLY a valid JSON object with these keys:
- title (string)
- content (string, HTML using h2/h3/p/ul/li/strong/em only — no scripts, no inline event handlers)
- excerpt (string, 1-2 sentences)
- tags (array of short strings)
- metaTitle (string, SEO title <= 60 chars)
- metaDescription (string, SEO description <= 155 chars)
Write the full article in HTML suitable for Wix Blog publishing. Do not wrap JSON in markdown.`;

  const userPrompt = `Write a complete blog post.
Topic: ${String(topic).trim()}
Tone: ${tone || "Professional"}
Language: ${language || "English"}
Target length: ${length || "1500 words"}`;

  const response = await client.chat.completions.create({
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from GPT while generating blog");
  }

  return normalizeGeneratedBlog(content);
}

module.exports = {
  generateBlogFromTopic,
  sanitizeHtml,
};
