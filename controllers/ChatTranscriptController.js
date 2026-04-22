const ChatTranscriptSetting = require("../models/ChatTranscriptSetting");
const Client = require("../models/Client");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeEmailList(value, label) {
  if (!Array.isArray(value)) {
    return { error: httpError(400, `${label} must be an array`) };
  }
  const isValid = value
    .map((e) => (typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.trim() : ""))
    .every(Boolean);
  if (!isValid) {
    return { error: httpError(400, `${label} must be a valid email address`) };
  }
  const uniqueEmails = [...new Set(value)];
  return { emails: uniqueEmails, error: null };
}

// Create a new chat transcript and save it to the database
const createChatTranscript = async (req, res) => {
  try {
    const {
      userId,
      transcriptEmails,
      salesLeadEmails,
      supportTicketEmails,
      salesLeadPhone,
      supportTicketPhone,
    } = req.body;

    const result = await saveChatTranscriptSettings(  
      userId,
      transcriptEmails,
      salesLeadEmails,
      supportTicketEmails,
      salesLeadPhone,
      supportTicketPhone,
    );

    if (result instanceof Error) {
      const status = result.status || 500;
      return res.status(status).json({
        error: result.message || "Failed to save chat transcript settings",
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Failed to save chat transcript settings",
    });
  }
};

// Save the chat transcript settings to the database
async function saveChatTranscriptSettings(
  userId,
  transcriptEmails,
  salesLeadEmails,
  supportTicketEmails,
  salesLeadPhone,
  supportTicketPhone,
) {
  try {
    if (!userId) {
      return httpError(400, "User ID is required");
    }

    const allEmails = normalizeEmailList(
      transcriptEmails,
      "All chat transcript emails",
    );
    if (allEmails.error) return allEmails.error;

    const salesEmails = normalizeEmailList(
      salesLeadEmails,
      "Sales lead emails",
    );
    if (salesEmails.error) return salesEmails.error;

    const supportEmails = normalizeEmailList(
      supportTicketEmails,
      "Support ticket emails",
    );
    if (supportEmails.error) return supportEmails.error;

    const client = await Client.findOne({ userId });
    if (!client) {
      return httpError(404, "Client not found");
    }

    const chatTranscript = await ChatTranscriptSetting.findOneAndUpdate(
      { userId },
      {
        transcriptEmails: allEmails.emails,
        salesLeadEmails: salesEmails.emails,
        supportTicketEmails: supportEmails.emails,
        salesLeadPhone: salesLeadPhone || "",
        supportTicketPhone: supportTicketPhone || "",
      },
      { new: true, upsert: true, runValidators: true },
    );

    return chatTranscript;
  } catch (error) {
    if (error.code === 11000) {
      return httpError(409, "Chat transcript settings conflict for this user");
    }
    return httpError(
      500,
      error.message || "Failed to save chat transcript settings",
    );
  }
}

async function getChatTranscriptData(req, res) {
  try {
    const { userId } = req.body;
    const chatTranscript = await ChatTranscriptSetting.findOne({ userId }).lean();
    if (!chatTranscript) {
      return res.status(404).json({ error: "Chat transcript not found" });
    }
    return res.status(200).json({data:chatTranscript, status_code: 200});
  } catch (error) {
    return res
      .status(500)  
      .json({ error: error.message || "Failed to get chat transcript data", status_code: 500 });
  }
}

async function updateChatTranscriptData(req, res) {
  try {
    const {
      userId,
      transcriptEmails,
      salesLeadEmails,
      supportTicketEmails,
      salesLeadPhone,
      supportTicketPhone,
    } = req.body;

    const chatTranscript = await saveChatTranscriptSettings(
      userId,
      transcriptEmails,
      salesLeadEmails,
      supportTicketEmails,
      salesLeadPhone,
      supportTicketPhone,
    );
    
    if (chatTranscript instanceof Error) {
      return res
        .status(500)
        .json({
          error:
            chatTranscript.message || "Failed to update chat transcript data",
          status_code: 500,
        });
    }
    return res
      .status(200)
      .json({ message: "Chat transcript data updated successfully", status_code: 200 });
  } catch (error) {
    return res
      .status(500)
      .json({
        error: error.message || "Failed to update chat transcript data",
        status_code: 500,
      });
  }
}

module.exports = {
  createChatTranscript,
  saveChatTranscriptSettings,
  getChatTranscriptData,
  updateChatTranscriptData,
};
