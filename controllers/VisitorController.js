const Visitor = require("../models/Visitor");

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
const createVisitor = async (userId, visitorId) => {
  try {
    let name = await generateUniqueName(userId);

    const visitor = new Visitor({ userId, name, visitorId });
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
VisitorController.updateVisitorById = async ({
  id,
  location,
  ip,
  visitorDetails,
}) => {
  try {
    if (visitorDetails) {
      const transformedVisitorDetails = Object.entries(visitorDetails).map(
        ([key, value]) => ({
          field: key,
          value: value,
        })
      );

      // Find if there's a name field in visitorDetails
      const nameField = transformedVisitorDetails.find(detail => detail.field.trim().toLocaleLowerCase() === 'name');
      
      // Prepare update object
      const updateData = {
        location,
        ip,
        visitorDetails: transformedVisitorDetails
      };

      // Add name to update if it exists
      if (nameField) {
        updateData.name = nameField.value;
      }

      const visitor = await Visitor.findByIdAndUpdate(
        id,
        updateData,
        { new: true }
      );
      if (!visitor) {
        return res.status(404).json({ error: "Visitor not found" });
      }
      return visitor;
    } else {
      const visitor = await Visitor.findByIdAndUpdate(
        id,
        { location, ip },
        { new: true }
      );
      if (!visitor) {
        return res.status(404).json({ error: "Visitor not found" });
      }
      return visitor;
    }
  } catch (error) {
    return error;
  }
};

// Update an existing visitor by ID
// VisitorController.getIsVisitorExists = async (req, res) => {
//   const { id, userId } = req.body.basicInfo;
//   try {
//     const visitor = await Visitor.exists({ _id: id, userId: userId });

//     if (visitor) {
//       return res.status(200).json({ exists: true });
//     } else {
//       return res.status(200).json({ exists: false });
//     }
//   } catch (error) {
//     res.status(500).json({ error: "Failed to update visitor" });
//   }
// };

VisitorController.blockVisitor = async (visitorId) => {
  let id = visitorId.visitorId;
  try {
    await Visitor.findByIdAndUpdate({_id:id}, { is_blocked: true });
    return true;
  } catch (error) {
    return error
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
