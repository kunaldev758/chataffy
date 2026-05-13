const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const Store = require("../models/Store");
const User = require("../models/User");
const Client = require("../models/Client");
const Agent = require("../models/Agent");
const { provisionNewMerchantUser } = require("../services/CommerceMerchantProvisionService");
const { getAuthCookieOptions } = require("../helpers/helper");
const { sendWelcomeEmail } = require("../services/emailService");

const router = express.Router();

const CLIENT_ID = process.env.BC_CLIENT_ID;
const CLIENT_SECRET = process.env.BC_CLIENT_SECRET;
const CALLBACK_URL = `${process.env.BASE_URL}api/bigcommerce/auth/callback`;

function bigcommerceStoreQuery(storeHash) {
  return {
    storeHash,
    platform: "bigcommerce",
  };
}

// ─── 1. INSTALL CALLBACK ─────────────────────────────────────────────────────
router.get("/auth/callback", async (req, res) => {
  const { code, scope, context } = req.query;

  if (!code || !context) {
    return res.status(400).json({
      status_code: 400,
      status: false,
      message: "Missing required parameters",
    });
  }
  console.log(
    "installing app with parameters: code ---> ",
    code,
    "scope ---> ",
    scope,
    "context ---> ",
    context,
  );

  try {
    console.log("starting to get access token from bigcommerce");
    const { data } = await axios.post(
      "https://login.bigcommerce.com/oauth2/token",
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
        grant_type: "authorization_code",
        code,
        scope,
        context,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    console.log("access token generated");
    const {
      access_token,
      user,
      context: storeContext,
      scope: grantedScope,
    } = data;
    const storeHash = storeContext.split("/")[1];

    const [store, existingUser] = await Promise.all([
      Store.findOne(bigcommerceStoreQuery(storeHash)).lean(),
      User.findOne({ email: user.email }).lean(),
    ]);

    let newUser;
    let newClient;
    let resolvedClient = null;

    if (existingUser) {
      resolvedClient = await Client.findOne({
        $or: [{ userId: existingUser._id }, { email: user.email }],
      }).lean();
    }
    if (!store && !existingUser) {
      const provisioned = await provisionNewMerchantUser({
        email: user.email,
        name: user.name,
        provider: "bigcommerce",
      });
      newUser = provisioned.newUser;
      newClient = provisioned.newClient;
    }

    const resolvedUserId = newUser?._id ? newUser?._id : existingUser?._id;
    if (!resolvedUserId)
      throw new Error("Could not resolve user for store install");
    await Store.updateOne(
      { storeHash },
      {
        $set: {
          platform: "bigcommerce",
          userId: resolvedUserId,
          clientId: newClient?._id || resolvedClient?._id,
          accessToken: access_token,
          email: user.email,
          name: user.name || user.email || `store-${storeHash}`,
          scope: grantedScope,
          isDeleted: false,
          status: "installed",
          lastInstalledAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // sending installation email
    await sendWelcomeEmail(
      user.email,
      "bigcommerce",
      store.name || storeHash,
      `https://store-${storeHash}.mybigcommerce.com`,
      user.name,
      `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BC_APP_ID}`,
    );


    return res.redirect(
      `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BC_APP_ID}`,
    );
  } catch (err) {
    console.error(
      "[BigCommerce] Install error:",
      err.response?.data || err.message,
    );
    res.status(500).json({
      status_code: 500,
      status: false,
      message: "Installation failed",
    });
  }
});

// ─── LOAD CALLBACK ────────────────────────────────────────────────────────
router.get("/auth/load", async (req, res) => {
  const { signed_payload_jwt } = req.query;
  if (!signed_payload_jwt) {
    return res.status(400).send("Missing signed payload");
  }

  try {
    const payload = jwt.verify(signed_payload_jwt, CLIENT_SECRET, {
      algorithms: ["HS256"],
    });

    const { sub } = payload;
    const store_hash = sub.split("/")?.[1];

    const store = await Store.findOne(bigcommerceStoreQuery(store_hash)).lean();
    if (!store) {
      return res.status(403).json({
        status_code: 403,
        status: false,
        message: "Store not found. Please reinstall the app.",
      });
    }

    const [userData, agents] = await Promise.all([
      User.findById(store.userId).select("_id email isOnboarded"),
      Agent.find({ userId: store.userId, isDeleted: false })
        .select("_id agentName isActive")
        .lean(),
    ]);
    if (req.io) {
      req.io.emit("user-logged-in", { userId: userData._id });
    }

    const token = userData.generateAuthToken();
    userData.auth_token = token;
    await userData.save();

    const cookieOptions = getAuthCookieOptions(req);
    res.cookie("token", token, cookieOptions);
    res.cookie("role", "client", cookieOptions);
    res.status(200).json({
      status: true,
      userId: userData._id,
      isOnboarded: userData.isOnboarded,
      agents: agents,
      bigcommerceStoreHash: store_hash,
    });
  } catch (err) {
    console.error("Load error:", err.message);
    res.status(401).send("Unauthorized - invalid payload");
  }
});

// ─── UNINSTALL CALLBACK ───────────────────────────────────────────────────
router.get("/uninstall", async (req, res) => {
  console.log("uninstalling bigcommerce app");
  const { signed_payload_jwt } = req.query;

  if (!signed_payload_jwt) {
    console.log("missing signed payload while uninstalling bigcommerce app");
    return res.status(400).send("Missing signed payload");
  }

  try {
    const payload = jwt.verify(signed_payload_jwt, CLIENT_SECRET, {
      algorithms: ["HS256"],
    });
    console.log("payload ---> ", payload);
    const { sub } = payload;
    const store_hash = sub.split("/")?.[1];
    await Store.findOneAndUpdate(
      bigcommerceStoreQuery(store_hash),
      {
        status: "uninstalled",
        lastUninstalledAt: new Date(),
        accessToken: null,
      },
      { new: true },
    );

    res.status(200).send("Uninstalled successfully");
  } catch (err) {
    console.error("Uninstall error:", err.message);
    res.status(401).send("Unauthorized");
  }
});

module.exports = router;
