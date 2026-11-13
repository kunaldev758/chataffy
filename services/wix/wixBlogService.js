const axios = require("axios");
const { htmlToWixRichContent } = require("./wixRichContent");

function authHeaders(accessToken) {
  return {
    Authorization: accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function wixErrorMessage(response, fallback) {
  const raw =
    response?.data?.message ||
    response?.data?.error_description ||
    response?.data?.details?.applicationError?.description ||
    fallback;

  const text = String(raw || "");
  if (/no blog instanceid found/i.test(text)) {
    return (
      "Wix Blog app is not installed on this site. " +
      "Open the Wix site editor → Add Apps → Blog, create at least one post, then publish again."
    );
  }
  return text || fallback;
}

/**
 * Resolve a site member GUID to use as blog author (required for 3rd-party apps).
 */
async function resolveMemberId(accessToken, preferredMemberId) {
  if (preferredMemberId) return preferredMemberId;

  const listRes = await axios.get(
    "https://www.wixapis.com/members/v1/members?fieldsets=PUBLIC&paging.limit=1",
    {
      headers: authHeaders(accessToken),
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (
    listRes.status >= 200 &&
    listRes.status < 300 &&
    Array.isArray(listRes.data?.members) &&
    listRes.data.members[0]?.id
  ) {
    return listRes.data.members[0].id;
  }

  const createRes = await axios.post(
    "https://www.wixapis.com/members/v1/members",
    {
      member: {
        loginEmail: `chataffy-blog-${Date.now()}@example.com`,
        contact: {
          firstName: "Chataffy",
          lastName: "Author",
        },
        profile: {
          nickname: "Chataffy",
        },
      },
    },
    {
      headers: authHeaders(accessToken),
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (
    createRes.status >= 200 &&
    createRes.status < 300 &&
    createRes.data?.member?.id
  ) {
    return createRes.data.member.id;
  }

  throw new Error(
    wixErrorMessage(
      createRes.status >= 400 ? createRes : listRes,
      "Could not resolve a Wix memberId for blog author. Enable Members permission and try again."
    )
  );
}

/**
 * Create a Wix draft blog post (optionally publish immediately via publish:true).
 */
async function createDraftPost({
  accessToken,
  title,
  html,
  memberId,
  excerpt,
  language = "en",
  publish = false,
  hashtags = [],
}) {
  const richContent = htmlToWixRichContent(html);
  const draftPost = {
    title: String(title || "").trim(),
    memberId,
    richContent,
    language: String(language || "en").slice(0, 5).toLowerCase() || "en",
  };

  if (excerpt) {
    draftPost.excerpt = String(excerpt).trim();
  }
  if (Array.isArray(hashtags) && hashtags.length) {
    draftPost.hashtags = hashtags
      .map((t) => String(t).replace(/^#/, "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  const response = await axios.post(
    "https://www.wixapis.com/blog/v3/draft-posts",
    {
      draftPost,
      publish: !!publish,
      fieldsets: ["URL", "RICH_CONTENT"],
    },
    {
      headers: authHeaders(accessToken),
      timeout: 60000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      wixErrorMessage(
        response,
        `Wix create draft failed (HTTP ${response.status})`
      )
    );
  }

  const draft = response.data?.draftPost || response.data || {};
  return {
    draftPostId: draft.id || "",
    status: draft.status || (publish ? "PUBLISHED" : "UNPUBLISHED"),
    url: draft.url?.base || draft.url?.path || draft.url || "",
    raw: response.data,
  };
}

/**
 * Publish an existing draft post.
 */
async function publishDraftPost({ accessToken, draftPostId }) {
  if (!draftPostId) {
    throw new Error("draftPostId is required to publish");
  }

  const response = await axios.post(
    `https://www.wixapis.com/blog/v3/draft-posts/${encodeURIComponent(
      draftPostId
    )}/publish`,
    {},
    {
      headers: authHeaders(accessToken),
      timeout: 60000,
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      wixErrorMessage(
        response,
        `Wix publish failed (HTTP ${response.status})`
      )
    );
  }

  const postId = response.data?.postId || draftPostId;
  let postUrl = "";

  try {
    const getRes = await axios.get(
      `https://www.wixapis.com/blog/v3/posts/${encodeURIComponent(postId)}`,
      {
        headers: authHeaders(accessToken),
        params: { fieldsets: "URL" },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    if (getRes.status >= 200 && getRes.status < 300) {
      const post = getRes.data?.post || {};
      postUrl =
        post.url?.base ||
        (post.url?.path ? String(post.url.path) : "") ||
        "";
    }
  } catch {
    // URL is best-effort
  }

  return {
    postId,
    postUrl,
    raw: response.data,
  };
}

/**
 * Full publish pipeline: resolve member → create draft → publish (unless draftOnly).
 */
async function publishBlogToWix({
  accessToken,
  title,
  html,
  excerpt,
  tags = [],
  memberId,
  language = "en",
  draftOnly = false,
}) {
  const resolvedMemberId = await resolveMemberId(accessToken, memberId);

  if (!draftOnly) {
    // Prefer single-call publish when supported
    const created = await createDraftPost({
      accessToken,
      title,
      html,
      memberId: resolvedMemberId,
      excerpt,
      language,
      publish: true,
      hashtags: tags,
    });

    // Some responses still need explicit publish; if we got an id and no clear publish, publish.
    let postId = created.draftPostId;
    let postUrl = typeof created.url === "string" ? created.url : "";

    if (created.status === "UNPUBLISHED" && created.draftPostId) {
      const published = await publishDraftPost({
        accessToken,
        draftPostId: created.draftPostId,
      });
      postId = published.postId || postId;
      postUrl = published.postUrl || postUrl;
    }

    return {
      memberId: resolvedMemberId,
      draftPostId: created.draftPostId,
      postId,
      postUrl,
      status: "PUBLISHED",
    };
  }

  const draft = await createDraftPost({
    accessToken,
    title,
    html,
    memberId: resolvedMemberId,
    excerpt,
    language,
    publish: false,
    hashtags: tags,
  });

  return {
    memberId: resolvedMemberId,
    draftPostId: draft.draftPostId,
    postId: "",
    postUrl: typeof draft.url === "string" ? draft.url : "",
    status: "DRAFT",
  };
}

module.exports = {
  resolveMemberId,
  createDraftPost,
  publishDraftPost,
  publishBlogToWix,
  htmlToWixRichContent,
};
