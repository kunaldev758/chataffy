// module.exports = OpenAIUsageController;
require("dotenv").config();
const Usage = require('../models/UsageSchema');
const Client = require('../models/Client');
const UnifiedPricingService = require('../services/UnifiedPricingService'); // Correct path

// --- Configuration ---
const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const DEFAULT_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-3.5-turbo';
const CREDITS_PER_DOLLAR = parseFloat(process.env.CREDITS_PER_DOLLAR || "1000"); // Define conversion rate

// --- Initialize Services ---
// Pass the credits per dollar rate to the pricing service if it handles the conversion
const pricingService = new UnifiedPricingService(
    process.env.PINECONE_TIER || 'standard',
    process.env.PINECONE_POD_TYPE || 's1',
    CREDITS_PER_DOLLAR // Pass conversion rate
);


// --- Core Usage Logic Service ---
class UsageService {

    /**
     * Helper to convert dollars to credits.
     * Moved here for clarity, but calculation might live in UnifiedPricingService.
     * @param {number} dollarAmount - Cost in dollars.
     * @returns {number} - Equivalent credits.
     */
    _dollarsToCredits(dollarAmount) {
        // Prefer using the method from the pricing service if it exists
        if (typeof pricingService.dollarsToCredits === 'function') {
            return pricingService.dollarsToCredits(dollarAmount);
        }
        // Fallback calculation
        return Math.ceil(dollarAmount * CREDITS_PER_DOLLAR); // Use ceil to avoid fractional credits issues
    }

    /**
     * Checks if a user has sufficient credits for a given cost in dollars.
     * @param {string} userId - The user's ID.
     * @param {number} costInDollars - The estimated cost of the operation in dollars.
     * @returns {Promise<{sufficient: boolean, required: number, remaining: number}>}
     */
    async checkSufficientCredits(userId, costInDollars) {
        if (costInDollars <= 0) {
            return { sufficient: true, required: 0, remaining: Infinity }; // No cost, always sufficient
        }

        const creditsRequired = this._dollarsToCredits(costInDollars);

        const client = await Client.findOne({ userId }).select('credits').lean(); // Use lean and select
        if (!client) {
            console.error(`[UsageService] Client not found for userId: ${userId}`);
            return { sufficient: false, required: creditsRequired, remaining: 0 };
        }

        const currentUsedCredits = client.credits?.used || 0;
        const totalCredits = client.credits?.total || 0;
        const remainingCredits = totalCredits - currentUsedCredits;

        return {
            sufficient: remainingCredits >= creditsRequired,
            required: creditsRequired,
            remaining: remainingCredits
        };
    }

    /**
     * Records a usage event, calculates cost, deducts credits, and saves the usage log.
     * @param {string} userId - The user ID.
     * @param {string} operation - A code identifying the type of operation (e.g., 'train-data', 'chat', 'pinecone-query').
     * @param {object} details - Object containing data needed for cost calculation and logging.
     *   Expected properties (vary by operation):
     *   - embeddingTokens (number)
     *   - embeddingModel (string, optional default: DEFAULT_EMBEDDING_MODEL)
     *   - promptTokens (number)
     *   - completionTokens (number)
     *   - completionModel (string, optional default: DEFAULT_CHAT_MODEL)
     *   - pineconeQueries (number)
     *   - other arbitrary details to log...
     * @returns {Promise<{success: boolean, usage?: object, creditsUsed?: number, remainingCredits?: number, error?: string}>}
     */
    async recordUsage(userId, operation, details = {}) {
        try {
            // 1. Calculate Cost using UnifiedPricingService
            const costDetails = pricingService.calculateOperationCost({
                embeddingTokens: details.embeddingTokens || 0,
                embeddingModel: details.embeddingModel || DEFAULT_EMBEDDING_MODEL,
                promptTokens: details.promptTokens || 0,
                completionTokens: details.completionTokens || 0,
                questionTokens: details.questionTokens || 0,
                completionModel: details.completionModel || DEFAULT_CHAT_MODEL,
                pineconeQueries: details.pineconeQueries || 0,
                // Add other cost factors here if needed (e.g., image generation, function calls)
            });

            const totalCostInDollars = costDetails.totalCost;

            // 2. Check and Deduct Credits
            const creditsRequired = this._dollarsToCredits(totalCostInDollars);

            const client = await Client.findOne({ userId }); // Need the full client object to update
            if (!client) {
                throw new Error(`Client not found for userId: ${userId}`);
            }

            const currentUsedCredits = client.credits.used || 0;
            const totalCredits = client.credits.total || 0;
            const remainingCredits = totalCredits - currentUsedCredits;

            if (remainingCredits < creditsRequired) {
                 console.warn(`[UsageService] Insufficient credits for user ${userId}. Required: ${creditsRequired}, Remaining: ${remainingCredits}`);
                throw new Error('INSUFFICIENT_CREDITS'); // Use specific error code
            }

            // 3. Create Usage Log
            const usage = new Usage({
                userId,
                operation,
                details: {
                    ...details, // Log original details provided
                    cost: totalCostInDollars, // Store calculated cost in dollars
                    creditsCharged: creditsRequired, // Store credits deducted
                    costBreakdown: costDetails.breakdown, // Store detailed breakdown from pricing service
                    timestamp: new Date(), // Explicitly set timestamp
                },
            });
            await usage.save();

            // 4. Update Client Credits (Atomic increment is safer)
            const updatedClient = await Client.findOneAndUpdate(
                { userId },
                { $inc: { 'credits.used': creditsRequired } },
                { new: true } // Return the updated document
            );

            const finalRemaining = (updatedClient.credits.total || 0) - (updatedClient.credits.used || 0);
            console.log(`[UsageService] Recorded usage for ${userId}. Op: ${operation}, Cost: $${totalCostInDollars.toFixed(6)}, Credits: ${creditsRequired}, Remaining: ${finalRemaining}`);

            return {
                success: true,
                usage: usage.toObject(), // Return plain object
                creditsUsed: creditsRequired,
                remainingCredits: finalRemaining
            };

        } catch (error) {
            console.error(`[UsageService] Error recording usage for user ${userId}, operation ${operation}: ${error.message}`, error.stack);
             // Return the specific error message if it's insufficient credits
             if (error.message === 'INSUFFICIENT_CREDITS') {
                 return { success: false, error: error.message, errorCode: 'INSUFFICIENT_CREDITS' };
             }
            return { success: false, error: `Failed to record usage: ${error.message}` };
        }
    }

    /**
     * Retrieves usage statistics for a specific user.
     * @param {string} userId - The user's ID.
     * @returns {Promise<object>} - Usage statistics.
     */
    async getUserUsageStats(userId) {
        try {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const stats = await Usage.aggregate([
                { $match: { userId } }, // Filter by user
                {
                    $group: {
                        _id: '$operation', // Group by operation type
                        count: { $sum: 1 },
                        totalCost: { $sum: '$details.cost' }, // Summing cost in dollars
                        totalCreditsCharged: { $sum: '$details.creditsCharged' }, // Summing credits
                        // Optional: Calculate stats for the last 7 days
                        last7DaysCost: {
                            $sum: {
                                $cond: [{ $gte: ['$details.timestamp', sevenDaysAgo] }, '$details.cost', 0]
                            }
                        },
                         last7DaysCredits: {
                            $sum: {
                                $cond: [{ $gte: ['$details.timestamp', sevenDaysAgo] }, '$details.creditsCharged', 0]
                            }
                        },
                    }
                },
                {
                    $group: {
                        _id: null, // Group all operations together for totals
                        totalUsages: { $sum: '$count' },
                        overallTotalCost: { $sum: '$totalCost' },
                        overallTotalCreditsCharged: { $sum: '$totalCreditsCharged' },
                        overallLast7DaysCost: { $sum: '$last7DaysCost'},
                        overallLast7DaysCredits: { $sum: '$last7DaysCredits'},
                        usagesByOperation: { $push: { operation: '$_id', count: '$count', totalCost: '$totalCost', totalCreditsCharged: '$totalCreditsCharged' } }
                    }
                },
                 {
                    $project: { // Clean up the output
                        _id: 0,
                        totalUsages: 1,
                        overallTotalCost: 1,
                        overallTotalCreditsCharged: 1,
                        overallLast7DaysCost: 1,
                        overallLast7DaysCredits: 1,
                        usagesByOperation: 1,
                    }
                }
            ]);

            // If no usage found, aggregate returns empty array, return default structure
            if (stats.length === 0) {
                return {
                    totalUsages: 0,
                    overallTotalCost: 0,
                    overallTotalCreditsCharged: 0,
                    overallLast7DaysCost: 0,
                    overallLast7DaysCredits: 0,
                    usagesByOperation: [],
                };
            }

            return stats[0]; // Aggregate returns an array with one element here

        } catch (error) {
            console.error(`[UsageService] Error fetching usage stats for user ${userId}: ${error.message}`);
            throw new Error('Failed to fetch usage statistics'); // Re-throw for controller to handle
        }
    }
}

// Instantiate the service
const usageService = new UsageService();

// --- Controller for Routes and Service Functions ---
const UsageController = {

    // --- Service Functions (for internal use by other modules) ---

    /**
     * Records usage and deducts credits. Calculates cost based on details.
     * @param {string} userId - User ID.
     * @param {string} operation - Operation code (e.g., 'train-data').
     * @param {object} details - Details for cost calculation (e.g., { embeddingTokens: 1000 }).
     * @returns {Promise<object>} - Result object { success, usage?, creditsUsed?, remainingCredits?, error? }.
     */
    recordUsage: async (userId, operation, details) => {
        return await usageService.recordUsage(userId, operation, details);
    },

    /**
     * Specific recorder for chat operations.
     * @param {string} userId - User ID.
     * @param {object} chatDetails - Details like { promptTokens, completionTokens, completionModel, embeddingCost, pineconeCost }.
     * @returns {Promise<object>} - Result object.
     */
    recordChatUsage: async (userId, chatDetails) => {
        // Prepare details specifically for the recordUsage method
        const detailsForRecording = {
            promptTokens: chatDetails.promptTokens || 0,
            completionTokens: chatDetails.completionTokens || 0,
            completionModel: chatDetails.completionModel || DEFAULT_CHAT_MODEL,
            // Include costs passed from QA system if they represent separate operations
            // For example, if embedding/pinecone cost was *already recorded* separately, don't double count.
            // If they should be part of *this* chat operation's cost, the main recordUsage
            // should ideally calculate them based on tokens/queries passed in `chatDetails`.
            // Let's assume the main recordUsage calculates based on tokens passed:
             embeddingTokens: chatDetails.embeddingTokens || 0, // Tokens used for question embedding in this turn
             embeddingModel: chatDetails.embeddingModel || DEFAULT_EMBEDDING_MODEL,
             pineconeQueries: chatDetails.pineconeQueries || 0, // Number of pinecone queries in this turn
             // Include any other relevant details from chatDetails
             conversationId: chatDetails.conversationId,
        };
        return await usageService.recordUsage(userId, 'chat', detailsForRecording);
    },

    /**
     * Checks if a user has enough credits for an operation estimated to cost a certain amount in dollars.
     * @param {string} userId - User ID.
     * @param {number} estimatedCostInDollars - Estimated cost.
     * @returns {Promise<boolean>} - True if credits are sufficient, false otherwise.
     */
    checkUserCredits: async (userId, estimatedCostInDollars) => {
        try {
            const checkResult = await usageService.checkSufficientCredits(userId, estimatedCostInDollars);
            return checkResult.sufficient;
        } catch (error) {
            console.error(`[UsageController] Error checking user credits for ${userId}: ${error.message}`);
            return false; // Default to false on error
        }
    },


    // --- Express Route Handlers ---

    getAllUsages: async (req, res) => {
        try {
            // Add pagination later if needed
            const usages = await Usage.find().sort({ 'details.timestamp': -1 }).limit(100); // Limit for safety
            res.status(200).json(usages);
        } catch (error) {
             console.error("[UsageController Route] Failed to fetch usages:", error);
            res.status(500).json({ success: false, error: 'Failed to fetch usages' });
        }
    },

    getUsageById: async (req, res) => {
        try {
            const usage = await Usage.findById(req.params.id);
            if (!usage) {
                return res.status(404).json({ success: false, error: 'Usage record not found' });
            }
            res.status(200).json(usage);
        } catch (error) {
            console.error(`[UsageController Route] Failed to fetch usage ${req.params.id}:`, error);
             // Handle potential CastError for invalid ID format
             if (error.name === 'CastError') {
                 return res.status(400).json({ success: false, error: 'Invalid usage ID format' });
             }
            res.status(500).json({ success: false, error: 'Failed to fetch usage record' });
        }
    },

    // Get usage statistics for a specific user (e.g., /api/usage/stats/user/:userId)
    getUserStats: async (req, res) => {
        try {
            const userId = req.params.userId;
            if (!userId) {
                 return res.status(400).json({ success: false, error: 'User ID is required' });
            }
            const stats = await usageService.getUserUsageStats(userId);
            res.status(200).json({ success: true, data: stats });
        } catch (error) {
             console.error(`[UsageController Route] Failed to fetch usage stats for user ${req.params.userId}:`, error);
            res.status(500).json({ success: false, error: 'Failed to fetch usage statistics' });
        }
    },

};

// Export the controller object containing route handlers and service functions
module.exports = UsageController;