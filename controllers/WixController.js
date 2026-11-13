const WixConnection = require("../models/WixConnection");
const BlogPost = require("../models/BlogPost");
const {
  isWixConfigured,
  buildInstallUrl,
  verifyOAuthState,
  exchangeAuthorizationCode,
  createAccessTokenWithInstance,
  fetchAppInstance,
  encryptTokenFields,
  ensureAccessToken,
  getDashboardBlogUrl,
  getWixRedirectUri,
  WIX_APP_ID,
} = require("../services/wix/wixAuthService");
const { publishBlogToWix } = require("../services/wix/wixBlogService");

const WixController = {};

function publicConnection(doc) {
  if (!doc || !doc.isConnected) {
    return {
      isConnected: false,
      siteUrl: "",
      siteDisplayName: "",
      siteId: "",
      instanceId: "",
      memberId: "",
      lastVerifiedAt: null,
    };
  }
  return {
    isConnected: true,
    siteUrl: doc.siteUrl || "",
    siteDisplayName: doc.siteDisplayName || "",
    siteId: doc.siteId || "",
    instanceId: doc.instanceId || "",
    memberId: doc.memberId || "",
    lastVerifiedAt: doc.lastVerifiedAt || null,
    connectedAt: doc.updatedAt || doc.createdAt || null,
  };
}

function redirectToBlog(res, query) {
  const base = getDashboardBlogUrl();
  const url = new URL(base.includes("://") ? base : `https://${base}`);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  return res.redirect(302, url.toString());
}

/**
 * POST /api/wix/connect — returns Wix installer URL for the logged-in user.
 */
WixController.connect = async (req, res) => {
  try {
    if (!isWixConfigured()) {
      return res.status(503).json({
        status: false,
        message:
          "Wix integration is not configured. Add WIX_APP_ID and WIX_APP_SECRET.",
      });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(401).json({
        status: false,
        message: "Unauthorized",
      });
    }

    const { authorizeUrl } = buildInstallUrl(userId);
    return res.json({
      status: true,
      message: "Redirect to Wix to authorize.",
      authorizeUrl,
    });
  } catch (error) {
    console.error("[Wix] connect error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to start Wix connection.",
    });
  }
};

/**
 * GET /api/wix/callback — modern install callback from Wix.
 * Query: instanceId, tenantId?, appId?, state (from our postInstallationUrl)
 * Legacy code? is still accepted if present.
 */
WixController.callback = async (req, res) => {
  try {
    const {
      code,
      instanceId: instanceIdRaw,
      tenantId,
      state,
      error,
      error_description: errorDescription,
    } = req.query;

    if (error) {
      return redirectToBlog(res, {
        wix: "error",
        message: errorDescription || error,
      });
    }

    const verified = verifyOAuthState(state);
    if (!verified.ok) {
      return redirectToBlog(res, {
        wix: "error",
        message: `Invalid OAuth state (${verified.reason})`,
      });
    }

    const userId = verified.userId;
    let instanceId = instanceIdRaw ? String(instanceIdRaw) : "";
    let accessToken = "";
    let refreshToken = "";
    let expiresIn = 4 * 60 * 60;

    if (!instanceId) {
      return redirectToBlog(res, {
        wix: "error",
        message:
          "Missing instanceId from Wix. Use Connect Wix again (modern app-installer flow).",
      });
    }

    // Prefer modern client_credentials + instance_id
    try {
      const tokens = await createAccessTokenWithInstance(instanceId);
      accessToken = tokens.accessToken;
      expiresIn = tokens.expiresIn;
    } catch (err) {
      console.warn(
        "[Wix] client_credentials failed, trying legacy code exchange:",
        err.message
      );
    }

    if (!accessToken && code) {
      try {
        const tokens = await exchangeAuthorizationCode(String(code));
        accessToken = tokens.accessToken;
        refreshToken = tokens.refreshToken || "";
        expiresIn = tokens.expiresIn;
      } catch (err) {
        console.warn("[Wix] authorization_code exchange failed:", err.message);
      }
    }

    if (!accessToken) {
      return redirectToBlog(res, {
        wix: "error",
        message:
          "Could not obtain Wix access token. Check WIX_APP_ID / WIX_APP_SECRET and Permissions.",
      });
    }

    const instanceInfo = await fetchAppInstance(accessToken);
    if (instanceInfo?.instanceId) {
      instanceId = instanceInfo.instanceId;
    }

    const encrypted = encryptTokenFields({
      accessToken,
      refreshToken,
      expiresIn,
    });

    await WixConnection.deleteMany({
      $or: [{ userId }, { instanceId }],
    });

    const doc = await WixConnection.create({
      userId,
      instanceId,
      siteId: instanceInfo?.siteId || (tenantId ? String(tenantId) : ""),
      siteDisplayName: instanceInfo?.siteDisplayName || "",
      siteUrl: instanceInfo?.siteUrl || "",
      accessToken: encrypted.accessToken,
      refreshToken: encrypted.refreshToken,
      expiresAt: encrypted.expiresAt,
      scopes: Array.isArray(instanceInfo?.permissions)
        ? instanceInfo.permissions.join(",")
        : "",
      isConnected: true,
      lastVerifiedAt: new Date(),
    });

    return redirectToBlog(res, {
      wix: "connected",
      site: doc.siteDisplayName || doc.siteId || "ok",
    });
  } catch (error) {
    console.error("[Wix] callback error:", error.message);
    return redirectToBlog(res, {
      wix: "error",
      message: error.message || "Wix connection failed",
    });
  }
};

/**
 * Optional App URL entry when Wix redirects with ?token= during install.
 * Completes the installer handshake then continues to redirectUrl.
 */
WixController.appInstallEntry = async (req, res) => {
  try {
    if (!isWixConfigured()) {
      return res.status(503).send("Wix is not configured");
    }
    const token = req.query.token;
    const state = req.query.state || "";
    const params = new URLSearchParams({
      token: String(token || ""),
      appId: WIX_APP_ID(),
      redirectUrl: getWixRedirectUri(),
    });
    if (state) params.set("state", String(state));
    return res.redirect(
      302,
      `https://www.wix.com/installer/install?${params.toString()}`
    );
  } catch (error) {
    console.error("[Wix] appInstallEntry error:", error.message);
    return redirectToBlog(res, {
      wix: "error",
      message: error.message || "Install entry failed",
    });
  }
};

WixController.status = async (req, res) => {
  try {
    const userId = req.body.userId;
    const doc = await WixConnection.findOne({ userId }).lean();
    return res.json({
      status: true,
      configured: isWixConfigured(),
      connection: publicConnection(doc),
    });
  } catch (error) {
    console.error("[Wix] status error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to fetch Wix connection status.",
    });
  }
};

WixController.disconnect = async (req, res) => {
  try {
    const userId = req.body.userId;
    await WixConnection.findOneAndDelete({ userId });
    return res.json({
      status: true,
      message: "Wix disconnected.",
      connection: publicConnection(null),
    });
  } catch (error) {
    console.error("[Wix] disconnect error:", error.message);
    return res.status(500).json({
      status: false,
      message: "Failed to disconnect Wix.",
    });
  }
};

/**
 * POST /api/wix/publish — create + publish blog on connected Wix site.
 * Body: { blogId, status?: 'publish' | 'draft' }
 */
WixController.publish = async (req, res) => {
  try {
    const userId = req.body.userId;
    const { blogId, status: publishStatus = "publish" } = req.body;

    if (!blogId) {
      return res.status(400).json({
        status: false,
        message: "blogId is required.",
      });
    }

    const conn = await WixConnection.findOne({ userId });
    if (!conn || !conn.isConnected) {
      return res.status(400).json({
        status: false,
        message: "Wix is not connected. Connect your Wix site first.",
      });
    }

    const blog = await BlogPost.findOne({ _id: blogId, userId });
    if (!blog) {
      return res.status(404).json({
        status: false,
        message: "Blog not found.",
      });
    }
    if (!blog.title || !blog.content) {
      return res.status(400).json({
        status: false,
        message: "Blog title and content are required before publishing.",
      });
    }

    const tokenResult = await ensureAccessToken(conn);
    if (tokenResult.encrypted) {
      conn.accessToken = tokenResult.encrypted.accessToken;
      if (tokenResult.encrypted.refreshToken) {
        conn.refreshToken = tokenResult.encrypted.refreshToken;
      }
      conn.expiresAt = tokenResult.encrypted.expiresAt;
      await conn.save();
    }

    const draftOnly = String(publishStatus).toLowerCase() === "draft";
    const language =
      String(blog.language || "English")
        .toLowerCase()
        .startsWith("hindi")
        ? "hi"
        : "en";

    try {
      const result = await publishBlogToWix({
        accessToken: tokenResult.accessToken,
        title: blog.title,
        html: blog.content,
        excerpt: blog.excerpt,
        tags: blog.tags,
        memberId: conn.memberId || "",
        language,
        draftOnly,
      });

      if (result.memberId && result.memberId !== conn.memberId) {
        conn.memberId = result.memberId;
        conn.lastVerifiedAt = new Date();
        await conn.save();
      }

      blog.wixDraftPostId = result.draftPostId || blog.wixDraftPostId || "";
      blog.wixPostId = result.postId || "";
      blog.wixPostUrl = result.postUrl || "";
      blog.wixStatus = result.status || "";
      blog.publishedPlatform = "wix";
      blog.publishedAt = new Date();
      blog.status = draftOnly ? "generated" : "published";
      blog.publishError = "";
      await blog.save();

      return res.json({
        status: true,
        message: draftOnly
          ? "Blog saved as draft on Wix."
          : "Blog published to Wix.",
        blog,
        wix: {
          draftPostId: result.draftPostId,
          postId: result.postId,
          postUrl: result.postUrl,
          status: result.status,
        },
      });
    } catch (publishError) {
      blog.status = "failed";
      blog.publishError = publishError.message || "Wix publish failed";
      blog.publishedPlatform = "wix";
      await blog.save();
      throw publishError;
    }
  } catch (error) {
    console.error("[Wix] publish error:", error.message);
    return res.status(400).json({
      status: false,
      message: error.message || "Failed to publish blog to Wix.",
    });
  }
};

module.exports = WixController;
