const PLATFORM_CONFIG = {
  shopify: {
    name: "Shopify",
    color: "#96BF48",
    dashboardLabel: "Shopify Admin",
    logo: "https://cdn.worldvectorlogo.com/logos/shopify.svg",
    docsUrl: "https://help.shopify.com",
    supportUrl: "https://help.shopify.com/en/support",
  },
  bigcommerce: {
    name: "BigCommerce",
    color: "#34313F",
    dashboardLabel: "BigCommerce Control Panel",
    logo: "https://www.bigcommerce.com/assets/bigcommerce-logo.png",
    docsUrl: "https://developer.bigcommerce.com",
    supportUrl: "https://support.bigcommerce.com",
  },
};

/**
 * Generates an installation welcome email HTML
 * @param {Object} options
 * @param {'shopify' | 'bigcommerce'} options.platform
 * @param {string} options.storeName
 * @param {string} options.storeUrl
 * @param {string} options.ownerName
 * @param {string} options.appName
 * @param {string} options.dashboardUrl  - direct link to your app's dashboard
 */
function generateInstallEmail({
  platform,
  storeName,
  storeUrl,
  ownerName,
  appName,
  dashboardUrl,
}) {
  const p = PLATFORM_CONFIG[platform];
  if (!p) throw new Error(`Unsupported platform: ${platform}`);

  const greeting = ownerName ? `Hi ${ownerName},` : "Hello,";

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome to ${appName}</title>
    <!--[if mso]>
    <noscript>
      <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
    </noscript>
    <![endif]-->
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  
    <!-- Wrapper -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;padding:40px 0;">
      <tr>
        <td align="center">
  
          <!-- Card -->
          <table width="600" cellpadding="0" cellspacing="0" border="0"
            style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:600px;width:100%;">
  
            <!-- Header Banner -->
            <tr>
              <td style="background:linear-gradient(135deg, ${p.color} 0%, ${adjustColor(p.color)} 100%);padding:40px 48px;text-align:center;">
                <h1 style="margin:0 0 8px;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">
                  ${appName}
                </h1>
                <p style="margin:0;color:rgba(255,255,255,0.85);font-size:15px;">
                  Successfully installed on ${p.name}
                </p>
              </td>
            </tr>
  
            <!-- Body -->
            <tr>
              <td style="padding:36px 48px 24px;">
                <p style="margin:0 0 16px;font-size:16px;color:#1a1a2e;line-height:1.6;">${greeting}</p>
                <p style="margin:0 0 16px;font-size:15px;color:#4a4a68;line-height:1.7;">
                  Thank you for installing <strong>${appName}</strong> on your ${p.name} store
                  <strong>${storeName}</strong>.
                </p>
                <p style="margin:0 0 28px;font-size:15px;color:#4a4a68;line-height:1.7;">
                  Here's what you can do next:
                </p>
  
                <!-- Steps -->
                ${renderStep("01", "Open your App Dashboard", `Access all features of ${appName} from your central dashboard.`, p.color)}
                
              </td>
            </tr>
  
            
  
            <!-- CTA Button -->
            <tr>
              <td style="padding:0 48px 40px;text-align:center;">
                <a href="${dashboardUrl}"
                  style="display:inline-block;background:${p.color};color:#ffffff;text-decoration:none;
                    font-size:15px;font-weight:700;padding:14px 40px;border-radius:8px;
                    letter-spacing:0.3px;box-shadow:0 4px 16px ${p.color}55;">
                  Go to Dashboard →
                </a>
              </td>
            </tr>
  
            <!-- Divider -->
            <tr>
              <td style="padding:0 48px;">
                <hr style="border:none;border-top:1px solid #e8e8f0;margin:0;" />
              </td>
            </tr>
  
            <!-- Footer -->
            <tr>
              <td style="padding:28px 48px;text-align:center;">
                <p style="margin:0 0 8px;font-size:13px;color:#9999bb;line-height:1.6;">
                  You're receiving this because <strong>${appName}</strong> was installed on your
                  ${p.name} store at <a href="${storeUrl}" style="color:${p.color};text-decoration:none;">${storeUrl}</a>.
                </p>
                <p style="margin:0;font-size:12px;color:#bbbbcc;">
                  © ${new Date().getFullYear()} ${appName}. All rights reserved.
                </p>
              </td>
            </tr>
  
          </table>
          <!-- /Card -->
  
        </td>
      </tr>
    </table>
    <!-- /Wrapper -->
  
  </body>
  </html>`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderStep(number, title, description, color) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
      <tr>
        <td width="44" valign="top" style="padding-top:2px;">
          <span style="display:inline-block;width:32px;height:32px;background:${color}18;color:${color};
            border-radius:50%;font-size:11px;font-weight:800;text-align:center;line-height:32px;">
            ${number}
          </span>
        </td>
        <td valign="top">
          <p style="margin:0 0 3px;font-size:15px;font-weight:700;color:#1a1a2e;">${title}</p>
          <p style="margin:0 0 5px;font-size:14px;color:#6b6b8a;line-height:1.5;">${description}</p>
        </td>
      </tr>
    </table>`;
}

/** Darken hex color slightly for gradient end */
function adjustColor(hex) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.max(0, (num >> 16) - 30);
  const g = Math.max(0, ((num >> 8) & 0xff) - 30);
  const b = Math.max(0, (num & 0xff) - 30);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

module.exports = { generateInstallEmail };
