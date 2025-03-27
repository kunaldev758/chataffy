const ScrapeTracker = {
    // Store tracking info by userId
    trackingInfo: {},
  
    // Initialize tracking for a user
    initTracking(userId, totalPages) {
      this.trackingInfo[userId] = {
        totalPages,
        scrapingCompleted: 0,
        minifyingCompleted: 0,
        trainingCompleted: 0,
        failedPages: 0,
        startTime: Date.now(),
        trainingListIds: []
      };
      return this.trackingInfo[userId];
    },
  
    // Update tracking info
    updateTracking(userId, stage, completed = true) {
      if (!this.trackingInfo[userId]) return null;
      
      const info = this.trackingInfo[userId];
      
      if (stage === 'scraping' && completed) {
        info.scrapingCompleted++;
      } else if (stage === 'minifying' && completed) {
        info.minifyingCompleted++;
      } else if (stage === 'training' && completed) {
        info.trainingCompleted++;
      } else if (!completed) {
        info.failedPages++;
      }
      
      info.lastUpdate = Date.now();
      return info;
    },
  
    // Get tracking info for a user
    getTracking(userId) {
      return this.trackingInfo[userId] || null;
    },
  
    // Add a training list ID to track
    addTrainingListId(userId, trainingListId) {
      if (!this.trackingInfo[userId]) return;
      
      if (!this.trackingInfo[userId].trainingListIds.includes(trainingListId)) {
        this.trackingInfo[userId].trainingListIds.push(trainingListId);
      }
    },
  
    // Clear tracking for a user
    clearTracking(userId) {
      delete this.trackingInfo[userId];
    }
  };
  
  // Export the tracker so it can be used across files
  module.exports = ScrapeTracker;