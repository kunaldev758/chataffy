const nodemailer = require("nodemailer");
const User = require("../models/User")

// Create a transporter using SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});


const sendAgentApprovalEmail = async (agent,acceptUrl,password) => {
  // const acceptUrl = `${process.env.CLIENT_URL}/agents/accept-invite/${agent.inviteToken}`;
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: agent.email,
    subject: "Agent Account Approval",
    html: `
      <h1>Welcome ${agent.name}!</h1>
      <p>You have been invited as an agent. Please accept your invitation:</p>
      <p>Your login credentials:</p>
      <ul>
        <li>Email: ${agent.email}</li>
        <li>Password: ${password}</li>
      </ul>
      <a href="${acceptUrl}" target="_blank" style="...button styles...">Accept Invitation</a>
      <p>This link will expire in 24 hours.</p>
      <p>Best regards,<br>Your Team</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
};

const sendPlanUpgradeEmail = async (user, planName, amount, billingCycle) => {
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "Plan Upgrade Confirmation",
    html: `
      <p>Thank you for upgrading your plan!</p>
      <p><strong>Details of your subscription:</strong></p>
      <ul>
        <li>Plan: ${planName}</li>
        <li>Billing Cycle: ${billingCycle}</li>
        <li>Amount Paid: $${amount}</li>
      </ul>
      <p>Your account has been successfully updated with the new plan.</p>
      <p>If you have any questions, feel free to contact our support.</p>
      <br />
      <p>Best regards,<br/>The Chataffy Team</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error sending plan upgrade email:", error);
    return false;
  }
};

const sendPlanDowngradeEmail = async (user, newPlanName) => {
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "Plan Downgrade Notification",
    html: `
      <h2>Your Subscription Has Been Downgraded</h2>
      <p>Dear ${user.name || user.email},</p>
      <p>Your subscription has been downgraded to the <strong>${newPlanName}</strong> plan due to plan expiry or non-payment.</p>
      <p>If you believe this is a mistake or wish to upgrade again, please contact our support or visit your account dashboard.</p>
      <br />
      <p>Best regards,<br/>The Chataffy Team</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error sending plan downgrade email:", error);
    return false;
  }
};

const sendEmailForOfflineChat = async (email,location,ip,reason, message,userId) => {
  try {
    const user = await User.findById(userId);
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: user.email,
    subject: "Offline Chat",
    html: `
      <h2>New Offline Chat Received</h2>
      <p>You have received a new offline chat message. Here are the visitor details:</p>
      <ul>
        <li><strong>email:</strong> ${email}</li>
        <li><strong>location:</strong> ${location}</li>
        <li><strong>ip:</strong> ${ip}</li>
        <li><strong>reason:</strong> ${reason}</li>
      </ul>
      <p><strong>Message:</strong></p>
      <blockquote style="background:#f9f9f9;padding:10px;border-left:3px solid #ccc;">
        ${message}
      </blockquote>
      <br/>
      <p>Best regards,<br/>The Chataffy Team</p>
    `,
  };
  await transporter.sendMail(mailOptions);
  return true;
  } catch (error) {
    console.error("Error sending offline chat email:", error);
    return false;
  }
};


module.exports = {
  sendAgentApprovalEmail,
  sendPlanUpgradeEmail,
  sendPlanDowngradeEmail,
  sendEmailForOfflineChat,
};
