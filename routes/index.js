const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

// Enhanced multer configuration with file validation
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileExtension = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${fileExtension}`);
  },
});

// File filter for logo uploads
const logoFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png'];
  
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(file.mimetype) && allowedExtensions.includes(fileExtension)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG and PNG files are allowed'), false);
  }
};

// Configure multer with size limits and file filtering
const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 1 // Only one file at a time
  },
  fileFilter: logoFileFilter
});

// General upload for other files
const generalUpload = multer({ 
  storage,
  preservePath: true
}).single('file');

// Add middleware to preserve req.body
const preserveBody = (req, res, next) => {
  const bodyData = { ...req.body };
  req.on('end', () => {
    req.body = { ...bodyData, ...req.body };
  });
  next();
};

// Import controllers
const ChatMessageController = require('../controllers/ChatMessageController');
const UserController = require('../controllers/UserController');
const WidgetController = require('../controllers/WidgetController');
const agentController = require('../controllers/agentController');
const superAdminController = require('../controllers/superAdminController');
const scrapingController = require('../controllers/ScrapingController');
const PlanAdminController = require('../controllers/PlanAdminController');
const PlanController = require('../controllers/PlanController');
const ConversationController = require('../controllers/ConversationController');
const {verifySuperAdminToken} = require('../middleware/verifySuperAdminToken');
const middleware = require('../middleware/authMiddleware');

/* Public routes (no authentication required) */
router.get('/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

// Agent invitation acceptance (public)
router.post('/agents/accept-invite/:token', agentController.acceptInvite);

// Authentication routes (public)
router.post('/login', UserController.loginUser);
router.post('/createUser', UserController.createUser);
router.post('/verifyEmail', UserController.verifyEmail);
router.post('/oauth/google', UserController.googleOAuth);
router.post('/agents/login', agentController.agentLogin);

// Public widget routes (for embedded widgets)
router.get('/widget/:widgetId/:widgetToken/settings', WidgetController.getPublicWidgetSettings);
router.post('/widget/validate-form', WidgetController.validatePreChatForm);

// Public routes
router.post('/superadmin/login', superAdminController.superAdminLogin);
router.post('/create', superAdminController.createSuperAdmin); // For initial setup only

// Protected routes
router.get('/superadmin/dashboard', verifySuperAdminToken, superAdminController.getDashboardData);
router.get('/superadmin/clients', verifySuperAdminToken, superAdminController.getAllClients);
router.get('/superadmin/agent/:clientId', verifySuperAdminToken, superAdminController.getAgent);
router.get('/superadmin/cancel/sunscription/:clientId', verifySuperAdminToken, superAdminController.cancelClientSubscription);
router.get('/superadmin/delete/:userId',verifySuperAdminToken, UserController.deleteUser);


router.get('/superadmin/plan',verifySuperAdminToken, PlanAdminController.getAllPlans);
router.get('/superadmin/plan/stats',verifySuperAdminToken, PlanAdminController.getPlanStats.bind(PlanAdminController));
router.get('/superadmin/plan/:planId',verifySuperAdminToken, PlanAdminController.getPlan);
router.post('/superadmin/plan',verifySuperAdminToken, PlanAdminController.createPlan);
router.put('/superadmin/plan/:planId',verifySuperAdminToken, PlanAdminController.updatePlan);
router.delete('/superadmin/plan/:planId',verifySuperAdminToken, PlanAdminController.deletePlan);
router.post('/superadmin/plan/:planId/set-default',verifySuperAdminToken, PlanAdminController.setDefaultPlan);
router.post('/superadmin/migrate-users',verifySuperAdminToken, PlanAdminController.migrateUsers);


router.get('/available', PlanController.getAvailablePlans);


// User management
router.post('/logout',middleware, UserController.logoutUser);

//Get Client
router.post('/client',middleware,UserController.getClient);

// Scraping management
router.post('/openaiScrape',middleware, scrapingController.startSitemapScraping);
router.post('/continueAfterUpgrade',middleware, scrapingController.ContinueScrappingAfterUpgrade);
router.post('/upgradePlan',middleware,scrapingController.upgradePlan); //->check this if in use or not
// // Create snippet/document
router.post('/openaiCreateSnippet',middleware, preserveBody , generalUpload, scrapingController.createSnippet);
// // Create FAQ
router.post('/openaiCreateFaq',middleware, scrapingController.createFaq);
// // Get training list with filtering
router.get('/getOpenaiTrainingListDetail/:userId',middleware, scrapingController.getScrapingHistory);
router.get('/getDataField/:id',middleware,scrapingController.getFiledData)



// Chat message routes
router.post('/getConversationMessages',middleware, ChatMessageController.getAllChatMessagesAPI);
router.post('/getOldConversationMessages',middleware, ChatMessageController.getAllOldChatMessages);

// Enhanced Widget routes
router.post('/getWidgetToken',middleware, WidgetController.getWidgetToken);
router.post('/getBasicInfo',middleware, WidgetController.getBasicInfo);
router.post('/setBasicInfo',middleware, WidgetController.setBasicInfo);

// Logo upload with enhanced validation
router.post('/uploadLogo/:userId',middleware, upload.single('logo'), WidgetController.uploadLogo);

// Theme settings routes
router.get('/getThemeSettings/:userId',middleware, WidgetController.getThemeSettings);
router.post('/getThemeSettings',middleware, WidgetController.getThemeSettings); // Alternative POST method
router.post('/updateThemeSettings',middleware, WidgetController.updateThemeSettings);

// New enhanced widget routes
router.post('/updateWidgetPosition',middleware, WidgetController.updateWidgetPosition);

// Agent management routes
router.post('/agents',middleware, agentController.createAgent);
router.get('/agents',middleware, agentController.getAllAgents);
router.get('/agents/:id',middleware, agentController.getAgent);
router.post('/agents/:id',middleware, agentController.updateAgent);
router.post('/agents/delete/:id',middleware, agentController.deleteAgent);
router.post('/agents/:id/status',middleware, agentController.updateAgentStatus);

router.post('/sendEmailForOfflineChat', ConversationController.sendEmailForOfflineChatController);

// Error handling middleware for multer errors
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        status_code: 400,
        message: 'File too large. Maximum size allowed is 5MB.',
        error: 'FILE_TOO_LARGE'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        status_code: 400,
        message: 'Too many files. Only one file is allowed.',
        error: 'TOO_MANY_FILES'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        status_code: 400,
        message: 'Unexpected file field.',
        error: 'UNEXPECTED_FILE'
      });
    }
  }
  
  if (error.message === 'Only JPG and PNG files are allowed') {
    return res.status(400).json({
      status_code: 400,
      message: 'Invalid file type. Only JPG and PNG files are allowed.',
      error: 'INVALID_FILE_TYPE'
    });
  }
  
  // Pass other errors to the default error handler
  next(error);
});

module.exports = router;