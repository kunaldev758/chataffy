const express = require('express');
const router = express.Router();
const multer = require('multer');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
});
  
const upload = multer({ storage });
  
const OpenaiTrainingListController = require('../controllers/OpenaiTrainingListController');
const ChatMessageController = require('../controllers/ChatMessageController');
const UserController = require('../controllers/UserController');
const CreditsController = require('../controllers/CreditsController');
const WidgetController = require('../controllers/WidgetController');
const agentController = require('../controllers/AgentController');
const middleware = require('../middleware/authMiddleware');


/* Without middleware */
//please craete a test route to check if the server is running
router.get('/test', (req, res) => {
    res.json({ message: 'API is working!' });
});
router.post('/login', UserController.loginUser);
router.post('/createUser', UserController.createUser);
router.post('/verifyEmail', UserController.verifyEmail);

router.use(middleware);

router.post('/logout', UserController.logoutUser);

router.post('/openaiCreateSnippet', upload.single('file'), middleware, OpenaiTrainingListController.createSnippet);
router.post('/openaiScrape', OpenaiTrainingListController.scrape);


router.post('/openaiCreateFaq', OpenaiTrainingListController.createFaq);
router.post('/openaiToggleActiveStatus', OpenaiTrainingListController.toggleActiveStatus);
router.post('/getOpenaiTrainingListDetail', OpenaiTrainingListController.getTrainingListDetail);

router.post('/getTrainingStatus',OpenaiTrainingListController.getTrainingStatus);

router.post('/getUserCredits', CreditsController.getUserCredits);

router.post('/getConversationMessages', ChatMessageController.getAllChatMessagesAPI);
router.post('/getOldConversationMessages', ChatMessageController.getAllOldChatMessages);

router.post('/getWidgetToken', WidgetController.getWidgetToken);
router.post('/getBasicInfo', WidgetController.getBasicInfo);
router.post('/setBasicInfo', WidgetController.setBasicInfo);
router.post('/uploadLogo', upload.single('logo'),middleware, WidgetController.uploadLogo);
router.get('/getThemeSettings/:userId',WidgetController.getThemeSettings);
router.post('/updateThemeSettings',WidgetController.updateThemeSettings);


router.post('/agents', agentController.createAgent);

// Get all agents
router.get('/agents', agentController.getAllAgents);

// Get single agent
router.get('/agents/:id', agentController.getAgent);

// Update agent
router.post('/agents/:id', agentController.updateAgent);

// Delete agent
router.post('/agents/delete/:id', agentController.deleteAgent);

// Update agent status
router.post('/agents/:id/status', agentController.updateAgentStatus);

router.post('/agents/accept-invite/:token', agentController.acceptInvite);



module.exports = router;
