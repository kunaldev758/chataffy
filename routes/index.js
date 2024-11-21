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
  

// const ScraperController = require('../controllers/ScraperController');
// const TrainingListController = require('../controllers/TrainingListController');
// const TensorflowTrainingListController = require('../controllers/TensorflowTrainingListController');
const OpenaiTrainingListController = require('../controllers/OpenaiTrainingListController');
const ChatMessageController = require('../controllers/ChatMessageController');
const UserController = require('../controllers/UserController');
const CreditsController = require('../controllers/CreditsController');
const WidgetController = require('../controllers/WidgetController');
const OpenAIUsageController = require('../controllers/OpenAIUsageController');
const VisitorController = require('../controllers/VisitorController');
const ConversationTagController = require('../controllers/ConversationTagController');
const ConversatinController = require('../controllers/ConversationController');
const TrainingListController =  require('../controllers/TrainingListController');
const middleware = require('../middleware/authMiddleware');
/* Without middleware */
router.post('/login', UserController.loginUser);
router.post('/createUser', UserController.createUser);
router.post('/verifyEmail', UserController.verifyEmail);
// router.post('/updateOldVisitors', VisitorController.updateOldVisitors);


router.post('/openaiCreateSnippet', upload.single('file'), middleware, OpenaiTrainingListController.createSnippet);
router.use(middleware);
// router.post('/scrape', ScraperController.scrape);
// router.post('/tensorflowScrape', TensorflowTrainingListController.scrape);
router.post('/openaiScrape', OpenaiTrainingListController.scrape);
// router.post('/tensorflowCreateSnippet', TensorflowTrainingListController.createSnippet);
// router.post('/tensorflowCreateFaq', TensorflowTrainingListController.createFaq);
router.post('/openaiCreateFaq', OpenaiTrainingListController.createFaq);
// router.post('/tensorflowToggleActiveStatus', TensorflowTrainingListController.toggleActiveStatus);
router.post('/openaiToggleActiveStatus', OpenaiTrainingListController.toggleActiveStatus);
router.post('/getWidgetToken', WidgetController.getWidgetToken);
router.post('/logout', UserController.logoutUser);
// router.post('/getTrainingListDetail', TrainingListController.getTrainingListDetail);
// router.post('/getTensorflowTrainingListDetail', TensorflowTrainingListController.getTrainingListDetail);
router.post('/getOpenaiTrainingListDetail', OpenaiTrainingListController.getTrainingListDetail);
router.post('/getConversationMessages', ChatMessageController.getAllChatMessagesAPI);
router.post('/getMessageSources', ChatMessageController.getMessageSources);
router.post('/getBasicInfo', WidgetController.getBasicInfo);
router.post('/setBasicInfo', WidgetController.setBasicInfo);

/* Credits */
router.post('/getUserCredits', CreditsController.getUserCredits);

// router.use(middleware); // admin


router.get('/open-ai-usages-total-cost', OpenAIUsageController.sumTotalCost);


router.get('/getThemeSettings/:userId',WidgetController.getThemeSettings);
router.post('/updateThemeSettings',WidgetController.updateThemeSettings);
router.post('/getAllNoteToConveration',ChatMessageController.getAllChatNotesMessages)
router.post('/getAllOldConversationOfVisitor',ConversatinController.getAllOldConversations)
router.post('/getVisitorDetails',VisitorController.getVisitorById)

router.post('/getConversationTags',ConversationTagController.getAllTagsOfConversation)
router.post('/removeTagFromConversation',ConversationTagController.deleteTagById)
router.post('/addTagToConversation',ConversationTagController.createTagAPI)


//dashboard Apis
router.post('/getTotalMessages',ChatMessageController.getTotalChats);
router.post('/getTotalChats',ConversatinController.getTotalConversation);
router.post('/getSearchConversationList',ConversatinController.searchByTagOrName);
router.post('/addConversationToArchive',ConversatinController.AddConversationToArchive);
// router.post('/getTotalFallbackMessages',ConversatinController.getTotalFallbackMessages);
router.post('/getTrainingStatus',TrainingListController.getTrainingStatus);

router.post('/getCsatPercent',ChatMessageController.getCSAT);
router.post('/saveVisitorDetails',VisitorController.updateVisitorById);
router.post('/getIsVisitorExists',VisitorController.getIsVisitorExists);
router.post('/blockVisitor',VisitorController.blockVisitor);


router.post('/getOldConversationMessages', ChatMessageController.getAllOldChatMessagesAPI);
module.exports = router;
