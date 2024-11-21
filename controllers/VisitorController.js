const Visitor = require("../models/Visitor");
// const ChatMessage = require('../models/ChatMessage');
// const ObjectId = require('mongoose').Types.ObjectId;

const things = [
  "Shirt",
  "Window",
  "Twister",
  "Box",
  "Radio",
  "Apple",
  "Keyboard",
  "Chair",
  "Bow",
  "Album",
  "Jar",
  "Tire",
  "Swing",
  "Cup",
  "House",
  "Phone",
  "Pen",
  "Desk",
  "Clock",
  "Wheel",
  "Bag",
  "Belt",
  "Cable",
  "Wire",
  "Car",
  "Wallet",
  "Truck",
  "Tie",
  "Magnet",
  "Bike",
  "Television",
  "Brush",
  "Pencil",
  "Tractor",
  "Bottle",
  "Pebble",
  "Boat",
  "Chalk",
  "Book",
  "Van",
  "Key",
  "Remote",
  "Rope",
  "Handle",
  "Gear",
  "Chain",
  "Knob",
  "Cap",
  "Watch",
  "Trolley",
];
const colors = [
  "Magenta",
  "Coral",
  "Bisque",
  "Orange",
  "Red",
  "Azure",
  "Turquoise",
  "Green",
  "Blue",
  "Wheat",
  "Peach",
  "Violet",
  "Ivory",
  "Olive",
  "Salmon",
  "Green",
  "Pink",
  "Peru",
  "Golden",
  "Crimson",
  "Orchid",
  "Yellow",
  "Gray",
  "Aquamarine",
  "Sienna",
  "Thistle",
  "Cyan",
  "Silver",
  "Beige",
  "Purple",
  "Cornsilk",
  "Linen",
  "Moccasin",
  "Lavender",
  "Cornflower",
  "Lime",
  "Indigo",
  "Gainsboro",
  "Tan",
  "Khaki",
  "Mint",
  "Teal",
  "Chartreuse",
  "Lemon",
  "Fuchsia",
];

const getRandomElement = (array) =>
  array[Math.floor(Math.random() * array.length)];

// const generateAlphaSequence = () => {
//     const length = 3;
//     const lowerCharacters = 'abcdefghijklmnopqrstuvwxyz';
//     const upperCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
//     let sequence = upperCharacters[Math.floor(Math.random() * upperCharacters.length)];
//     for (let i = 1; i < length; i++) {
//         sequence += lowerCharacters[Math.floor(Math.random() * lowerCharacters.length)];
//     }
//     return sequence;
// };

const generateUniqueName = async (userId) => {
  let name;
  let isUnique = false;
  let attempt = 0;
  while (!isUnique && attempt++ < 3) {
    const randomThings = getRandomElement(things);
    const randomColors = getRandomElement(colors);
    // const alphaSequence = generateAlphaSequence();
    name = `${randomColors} ${randomThings}`; //  ${alphaSequence}

    // Check if the generated name already exists in the database
    const existingVisitor = await Visitor.findOne({ userId, name });

    // If the name doesn't exist, set isUnique to true
    if (!existingVisitor) {
      isUnique = true;
    }
  }
  return name;
};

const VisitorController = {};
// // Get all visitors
// VisitorController.updateOldVisitors = async (req, res) => {
//   try {
//     const visitors = await Visitor.find({});

//     for (const visitor of visitors) {
//       // Find the latest message for the visitor's conversation with sender_type visitor, bot, or agent
//       const chatMessage = await ChatMessage.findOne({
//         conversation_id: new ObjectId(visitor._id),
//         sender_type: { $in: ["visitor", "bot", "agent"] } // Condition for sender_type
//       }).sort({ createdAt: -1 }).exec();

//       if (chatMessage) {
//         visitor.lastMessage = chatMessage.message;
//         await visitor.save();
//       }else {
//         visitor.lastMessage = undefined;
//         await visitor.save();
//       }
//     }

//     console.log('Visitors updated successfully');
//     res.json({ result: "Done" });
//   } catch (error) {
//       res.status(500).json({ error: error.message });
//   }
// };

// Get all visitors
VisitorController.getAllVisitors = async (req, res) => {
  try {
    const visitors = await Visitor.find();
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch visitors" });
  }
};

// Get a single visitor by ID
VisitorController.getVisitorById = async (req, res) => {
  const { visitorId } = req.body;
  try {
    const visitor = await Visitor.findById(visitorId);
    if (!visitor) {
      return res.status(404).json({ error: "Visitor not found" });
    }
    res.json(visitor);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch visitor" });
  }
};

// Create a new visitor
const createVisitor = async (userId, name) => {
  try {
    if (!name) {
      name = await generateUniqueName(userId);
    }
    const visitor = new Visitor({ userId, name });
    await visitor.save();
    return visitor;
  } catch (error) {
    throw error;
  }
};
VisitorController.createVisitor = createVisitor;
VisitorController.createVisitorAPI = async (req, res) => {
  const { name } = req.body;
  try {
    const visitor = await createVisitor(name);
    res.status(201).json(visitor);
  } catch (error) {
    res.status(500).json({ error: "Failed to create visitor" });
  }
};

// Update an existing visitor by ID
VisitorController.updateVisitorById = async (req, res) => {
  // const { id } = req.params;
  const { id, userId, location, ip, visitorDetails } = req.body.basicInfo;
  try {
    const visitor = await Visitor.findByIdAndUpdate(
      id,
      { location, ip, visitorDetails, userId },
      { new: true }
    );
    if (!visitor) {
      return res.status(404).json({ error: "Visitor not found" });
    }
    res.json(visitor);
  } catch (error) {
    res.status(500).json({ error: "Failed to update visitor" });
  }
};

// Update an existing visitor by ID
VisitorController.getIsVisitorExists = async (req, res) => {
  const { id, userId } = req.body.basicInfo;
  try {
    const visitor = await Visitor.exists({ _id: id, userId: userId });

    if (visitor) {
      return res.status(200).json({ exists: true });
    } else {
      return res.status(200).json({ exists: false });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to update visitor" });
  }
};

VisitorController.blockVisitor = async (req, res) => {
  const { id } = req.body.basicInfo;
  try {
    await Visitor.findByIdAndUpdate(id, { is_blocked: true });
    return res.status(200).json({ message: "Blocked" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update visitor" });
  }
};

// Delete an existing visitor by ID
VisitorController.deleteVisitorById = async (req, res) => {
  const { id } = req.params;
  try {
    const visitor = await Visitor.findByIdAndDelete(id);
    if (!visitor) {
      return res.status(404).json({ error: "Visitor not found" });
    }
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: "Failed to delete visitor" });
  }
};

module.exports = VisitorController;
