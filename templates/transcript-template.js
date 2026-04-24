exports.chatTranscriptTemplate = (data) => {
  const colorFields = data.colorFields;
  const bubbleColor = colorFields.find((field) => field.name === "visitor_bubble")?.value;
  const bubbleTextColor = colorFields.find((field) => field.name === "visitor_bubble_text")?.value;
  const aiBubbleColor = colorFields.find((field) => field.name === "ai_bubble")?.value;
  const aiBubbleTextColor = colorFields.find((field) => field.name === "ai_bubble_text")?.value;
  const messagesHTML = data.messages
    .map((msg) => {
      const isVisitor = msg.sender_type === "visitor";
      const displayName = isVisitor ? data.visitorName : msg.sender;
      const rowClass = isVisitor ? "chat-msg chat-msg--visitor" : "chat-msg chat-msg--agent";
      const replyTo = msg.replyTo && (msg.replyTo.text || msg.replyTo.sender) ? msg.replyTo : null;
      const replySenderName = replyTo
        ? (replyTo.sender_type === "visitor" ? data.visitorName : (replyTo.sender || "Agent"))
        : "";
      const initials = String(displayName || "?")
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();


      return `
    <table class="${rowClass}" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        ${
          !isVisitor
            ? `
        <td align="right" valign="top">
          <div class="chat-msg__inner">
            <div class="chat-msg__bubble">
              ${
                replyTo
                  ? `
              <div class="chat-msg__reply">
                <div class="chat-msg__reply-sender">${replySenderName}</div>
                <div class="chat-msg__reply-text">${replyTo.text || ""}</div>
              </div>`
                  : ""
              }
              <div class="chat-msg__text">${msg.text}</div>
              <div class="chat-msg__meta">
                <span class="chat-msg__name">${displayName}</span>
                <span class="chat-msg__time">${msg.timestamp}</span>
              </div>
            </div>
          </div>
        </td>
        <td class="chat-msg__avatar-cell chat-msg__avatar-cell--visitor" width="40" align="right" valign="top">
          <div class="chat-msg__avatar chat-msg__avatar--visitor" aria-hidden="true">${initials}</div>
        </td>`
            : `
        <td class="chat-msg__avatar-cell" width="40" align="left" valign="top">
          <div class="chat-msg__avatar" aria-hidden="true">${initials}</div>
        </td>
        <td align="left" valign="top">
          <div class="chat-msg__inner">
            <div class="chat-msg__bubble">
              ${
                replyTo
                  ? `
              <div class="chat-msg__reply">
                <div class="chat-msg__reply-sender">${replySenderName}</div>
                <div class="chat-msg__reply-text">${replyTo.text || ""}</div>
              </div>`
                  : ""
              }
              <div class="chat-msg__text">${msg.text}</div>
              <div class="chat-msg__meta">
                <span class="chat-msg__name">${displayName}</span>
                <span class="chat-msg__time">${msg.timestamp}</span>
              </div>
            </div>
          </div>
        </td>`
        }
      </tr>
    </table>
  `;
    })
    .join("");

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Chat Transcript</title>
      <style>
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          margin: 0;
          padding: 24px 12px;
          -webkit-text-size-adjust: 100%;
        }
        .wrap {
          max-width: 600px;
          margin: 0 auto;
        }
        .card {
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
          overflow: hidden;
        }
        .meta-panel {
          padding: 20px 20px 16px;
          border-bottom: 1px solid #e9edef;
        }
        .meta-panel h1 {
          margin: 0 0 4px;
          font-size: 18px;
          font-weight: 600;
          color: #111b21;
        }
        .meta-panel .subtitle {
          margin: 0;
          font-size: 13px;
          color: #667781;
        }
        .meta-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 14px;
          font-size: 13px;
        }
        .meta-table td {
          padding: 6px 0;
          vertical-align: top;
          color: #3b4a54;
        }
        .meta-table td:first-child {
          width: 118px;
          font-weight: 600;
          color: #54656f;
        }
        .chat-window {
          padding: 16px 12px 20px;
          min-height: 160px;
        }
        .chat-window__label {
          text-align: center;
          margin-bottom: 14px;
        }
        .chat-window__label span {
          display: inline-block;
          padding: 4px 12px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: #54656f;
          background: rgba(255, 255, 255, 0.55);
          border-radius: 8px;
        }
        .chat-msg {
          width: 100%;
          margin-bottom: 6px;
          border-collapse: collapse;
        }
        .chat-msg td { padding: 0; }
        .chat-msg__avatar-cell { padding-right: 8px; }
        .chat-msg__avatar-cell--visitor { padding-left: 8px; padding-right: 0; }
        .chat-msg__avatar {
          width: 32px;
          height: 32px;
          margin-top: 2px;
          border-radius: 50%;
          background: ${aiBubbleColor};
          color: ${aiBubbleTextColor};
          font-size: 11px;
          font-weight: 700;
          line-height: 32px;
          text-align: center;
        }
        .chat-msg__avatar--visitor {
          background: ${bubbleColor};
          color: ${bubbleTextColor};
        }
        .chat-msg__inner {
          display: inline-block;
          max-width: 420px;
          vertical-align: top;
        }
        .chat-msg__bubble {
          display: inline-block;
          max-width: 100%;
          padding: 8px 12px 6px;
          border-radius: 8px;
          box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13);
        }
        .chat-msg--visitor .chat-msg__bubble {
          border-radius: 8px 8px 0 8px;
          background: ${bubbleColor};
          color: ${bubbleTextColor};
        }
        .chat-msg--agent .chat-msg__bubble {
          border-radius: 8px 8px 8px 0;
          background: ${aiBubbleColor};
          color: ${aiBubbleTextColor};
        }
        .chat-msg__text {
          font-size: 14px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .chat-msg__reply {
          margin-bottom: 8px;
          padding: 6px 8px;
          border-left: 3px solid rgba(17, 27, 33, 0.25);
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.35);
        }
        .chat-msg__reply-sender {
          font-size: 11px;
          font-weight: 700;
          margin-bottom: 2px;
        }
        .chat-msg__reply-text {
          font-size: 12px;
          line-height: 1.35;
          white-space: pre-wrap;
          word-break: break-word;
          opacity: 0.95;
        }
        .chat-msg__meta {
          margin-top: 4px;
          font-size: 11px;
          line-height: 1.3;
        }
        .chat-msg__name {
          font-weight: 600;
          margin-right: 6px;
        }
        .chat-msg__time {
          white-space: nowrap;
        }
        .chat-msg::after {
          content: "";
          display: table;
          clear: both;
        }
        .footer {
          text-align: center;
          padding: 16px 20px;
          color: #8696a0;
          font-size: 12px;
          border-top: 1px solid #e9edef;
          line-height: 1.5;
        }
        .footer p {
          margin: 0 0 6px;
        }
        .footer p:last-child {
          margin-bottom: 0;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="card">
          <div class="meta-panel">
            <h1>Chat Transcript</h1>
            <p class="subtitle">${data.websiteName}</p>
            <table class="meta-table" role="presentation">
              <tr>
                <td>Visitor</td>
                <td>${data.visitorName}</td>
              </tr>
              <tr>
                <td>Email</td>
                <td>${data.visitorEmail}</td>
              </tr>
              <tr>
                <td>Started</td>
                <td>${data.startedAt}</td>
              </tr>
              <tr>
                <td>Ended</td>
                <td>${data.endedAt}</td>
              </tr>
              <tr>
                <td>Duration</td>
                <td>${data.duration}</td>
              </tr>
            </table>
          </div>

          <div class="chat-window">
            <div class="chat-window__label"><span>Messages</span></div>
            ${messagesHTML}
          </div>

          <div class="footer">
            <p>This transcript was generated automatically.</p>
            <p>&copy; 2026 Chataffy. All rights reserved.</p>
          </div>
        </div>
      </div>
    </body>
  </html>`;
};
