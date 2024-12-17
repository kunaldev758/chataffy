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
const OpenAIUsageController = require('../controllers/OpenAIUsageController');
const TrainingListController =  require('../controllers/TrainingListController');
const middleware = require('../middleware/authMiddleware');
/* Without middleware */
router.post('/login', UserController.loginUser);
router.post('/createUser', UserController.createUser);
router.post('/verifyEmail', UserController.verifyEmail);



router.post('/openaiCreateSnippet', upload.single('file'), middleware, OpenaiTrainingListController.createSnippet);
router.use(middleware);

router.post('/openaiScrape', OpenaiTrainingListController.scrape);

router.post('/openaiCreateFaq', OpenaiTrainingListController.createFaq);

router.post('/openaiToggleActiveStatus', OpenaiTrainingListController.toggleActiveStatus);
router.post('/getWidgetToken', WidgetController.getWidgetToken);
router.post('/logout', UserController.logoutUser);

router.post('/getOpenaiTrainingListDetail', OpenaiTrainingListController.getTrainingListDetail);
router.post('/getConversationMessages', ChatMessageController.getAllChatMessagesAPI);
router.post('/getMessageSources', ChatMessageController.getMessageSources);
router.post('/getBasicInfo', WidgetController.getBasicInfo);
router.post('/setBasicInfo', WidgetController.setBasicInfo);


router.get('/getThemeSettings/:userId',WidgetController.getThemeSettings);
router.post('/updateThemeSettings',WidgetController.updateThemeSettings);

router.post('/uploadLogo', upload.single('logo'),middleware, WidgetController.uploadLogo);

/* Credits */
router.post('/getUserCredits', CreditsController.getUserCredits);

router.get('/open-ai-usages-total-cost', OpenAIUsageController.sumTotalCost);

router.post('/getTrainingStatus',TrainingListController.getTrainingStatus);

router.post('/getOldConversationMessages', ChatMessageController.getAllOldChatMessagesAPI);
module.exports = router;
