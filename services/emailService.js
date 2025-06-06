const nodemailer = require("nodemailer");

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


const sendAgentApprovalEmail = async (agent,acceptUrl) => {
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
        <li>Password: (the one you set during registration)</li>
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

module.exports = {
  sendAgentApprovalEmail,
};
