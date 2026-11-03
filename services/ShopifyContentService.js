const axios = require("axios");

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

const LIST_BLOGS_QUERY = `
  query ChataffyBlogCollections {
    blogs(first: 50) {
      nodes {
        id
        title
        handle
      }
    }
  }
`;

const CREATE_BLOG_MUTATION = `
  mutation ChataffyCreateBlog($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog {
        id
        title
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_ARTICLE_MUTATION = `
  mutation ChataffyCreateArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        title
        handle
        isPublished
        blog {
          id
          handle
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_ARTICLE_MUTATION = `
  mutation ChataffyUpdateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        title
        handle
        isPublished
        blog {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function userErrorMessage(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors
    .map((error) => error?.message)
    .filter(Boolean)
    .join("; ");
}

async function shopifyGraphql(shopDomain, accessToken, query, variables) {
  let response;
  try {
    response = await axios.post(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query, variables },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
    );
  } catch (err) {
    const status = err.response?.status;
    const detail =
      err.response?.data?.errors?.[0]?.message ||
      err.response?.data?.error ||
      err.message;
    const error = new Error(detail || "Shopify request failed");
    error.statusCode = status === 401 || status === 403 ? 403 : 502;
    error.code =
      status === 401 || status === 403 ? "SHOPIFY_SCOPE_REQUIRED" : "SHOPIFY_ERROR";
    throw error;
  }

  const body = response.data || {};
  if (Array.isArray(body.errors) && body.errors.length) {
    const message = body.errors.map((item) => item.message).join("; ");
    const denied = /access denied|required access|not approved|write_content/i.test(
      message,
    );
    const error = new Error(message);
    error.statusCode = denied ? 403 : 502;
    error.code = denied ? "SHOPIFY_SCOPE_REQUIRED" : "SHOPIFY_ERROR";
    throw error;
  }
  return body.data || {};
}

function mapArticle(article, fallbackBlogId) {
  if (!article?.id) return null;
  return {
    id: article.id,
    handle: article.handle || null,
    isPublished: Boolean(article.isPublished),
    blogId: article.blog?.id || fallbackBlogId || null,
    blogHandle: article.blog?.handle || null,
  };
}

async function listBlogCollections(shopDomain, accessToken) {
  const data = await shopifyGraphql(shopDomain, accessToken, LIST_BLOGS_QUERY, {});
  return (data.blogs?.nodes || []).map((blog) => ({
    id: blog.id,
    title: blog.title,
    handle: blog.handle,
  }));
}

async function createBlogCollection(shopDomain, accessToken, title) {
  const data = await shopifyGraphql(shopDomain, accessToken, CREATE_BLOG_MUTATION, {
    blog: { title },
  });
  const message = userErrorMessage(data.blogCreate?.userErrors);
  if (message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = "SHOPIFY_ERROR";
    throw error;
  }
  const blog = data.blogCreate?.blog;
  if (!blog?.id) {
    throw new Error("Shopify did not return a blog id");
  }
  return { id: blog.id, title: blog.title, handle: blog.handle };
}

async function createArticle(shopDomain, accessToken, article) {
  const data = await shopifyGraphql(shopDomain, accessToken, CREATE_ARTICLE_MUTATION, {
    article,
  });
  const message = userErrorMessage(data.articleCreate?.userErrors);
  if (message) {
    const denied = /access|permission|scope/i.test(message);
    const error = new Error(message);
    error.statusCode = denied ? 403 : 400;
    error.code = denied ? "SHOPIFY_SCOPE_REQUIRED" : "SHOPIFY_ERROR";
    throw error;
  }
  const mapped = mapArticle(data.articleCreate?.article, article.blogId);
  if (!mapped) throw new Error("Shopify did not return an article id");
  return mapped;
}

async function updateArticle(shopDomain, accessToken, id, article) {
  const data = await shopifyGraphql(shopDomain, accessToken, UPDATE_ARTICLE_MUTATION, {
    id,
    article,
  });
  const message = userErrorMessage(data.articleUpdate?.userErrors);
  if (message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = "SHOPIFY_ERROR";
    throw error;
  }
  const mapped = mapArticle(data.articleUpdate?.article);
  if (!mapped) throw new Error("Shopify did not return an article id");
  return mapped;
}

module.exports = {
  listBlogCollections,
  createBlogCollection,
  createArticle,
  updateArticle,
};
