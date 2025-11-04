// controllers/BigCommerceController.js
const axios = require('axios');

// START OAUTH: Redirects to BigCommerce OAuth endpoint
exports.startOAuth = (req, res) => {
    // TODO: Replace with your BigCommerce App's client_id and redirect URI
    const client_id = process.env.BC_CLIENT_ID;
    const redirect_uri = process.env.BC_CALLBACK_URL;
    const scopes = 'store_v2_products store_v2_customers'; // Add required scopes
    const context = req.query.context;
    const bcAuthUrl =
      `https://login.bigcommerce.com/oauth2/authorize?client_id=${client_id}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
      (context ? `&context=${encodeURIComponent(context)}` : '');

    res.redirect(bcAuthUrl);
};

// OAUTH CALLBACK
exports.oauthCallback = async (req, res) => {
    // TODO: Exchange code for access token, store shop credentials
    const { code, context, scope, store_hash } = req.query;
    const client_id = process.env.BC_CLIENT_ID;
    const client_secret = process.env.BC_CLIENT_SECRET;
    const redirect_uri = process.env.BC_CALLBACK_URL;

    try {
        const tokenRes = await axios.post('https://login.bigcommerce.com/oauth2/token', {
            client_id,
            client_secret,
            redirect_uri,
            grant_type: 'authorization_code',
            code,
            scope,
            context
        });
        // Store tokenRes.data in DB (incl. access_token, context, store_hash)
        // e.g., await BigCommerceStore.create({...})
        res.send('Installation successful! You can close this tab.');
    } catch (err) {
        console.error('OAuth Error:', err.message);
        res.status(500).send('BigCommerce OAuth failed.');
    }
};

// OPTIONAL: Webhook endpoint
exports.handleWebhook = (req, res) => {
    // TODO: Validate HMAC, handle webhook event
    res.status(200).send('Webhook received');
};
