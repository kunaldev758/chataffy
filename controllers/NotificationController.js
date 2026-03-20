const Notification = require("../models/Notification");

const NotificationController = {};

/**
 * Create a notification for agent connection request
 */
NotificationController.createAgentConnectionNotification = async (
  humanAgentId,
  conversationId,
  visitorId,
  userId,
  message = "Visitor requested to connect to an agent",
  agentId = null
) => {
  try {
    const notification = new Notification({
      humanAgentId,
      agentId,
      conversationId,
      visitorId,
      userId,
      message,
      type: "agent-connection-request",
      isSeen: false,
    });
    await notification.save();
    return notification;
  } catch (error) {
    throw error;
  }
};

/**
 * Get all notifications for an agent
 */
NotificationController.getByAgentId = async (req, res) => {
  try {
    const { agentId } = req.params;
    // agentId param carries the humanAgentId value for per-agent notification lookup
    const notifications = await Notification.find({ humanAgentId: agentId })
      .populate("conversationId", "visitor aiChat conversationOpenStatus")
      .populate("visitorId", "visitorDetails")
      .sort({ createdAt: -1 })
      .lean();
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
};

/**
 * Mark notification as seen
 */
NotificationController.markAsSeen = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await Notification.findByIdAndUpdate(
      id,
      { isSeen: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json(notification);
  } catch (error) {
    res.status(500).json({ error: "Failed to update notification" });
  }
};

/**
 * Mark all notifications for an agent as seen
 */
NotificationController.markAllAsSeenByAgentId = async (req, res) => {
  try {
    const { agentId } = req.params;
    const result = await Notification.updateMany(
      { humanAgentId: agentId, isSeen: false },
      { isSeen: true }
    );
    res.json({ modifiedCount: result.modifiedCount });
  } catch (error) {
    res.status(500).json({ error: "Failed to update notifications" });
  }
};

/**
 * Mark notifications for a conversation as seen (e.g. when agent accepts)
 */
NotificationController.markAsSeenByConversationId = async (conversationId) => {
  try {
    await Notification.updateMany(
      { conversationId, type: "agent-connection-request" },
      { isSeen: true }
    );
  } catch (error) {
    throw error;
  }
};

module.exports = NotificationController;
