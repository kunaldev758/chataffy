const ChatMessage = require('../models/ChatMessage');
const asyncHandler = require('express-async-handler');

const OpenAIController = require("./OpenAIController");
const OpenAIQueueController = require("./OpenAIQueueController");
const TrainingList = require("../models/TrainingList");
const OpenAITrainingList = require("../models/OpenaiTrainingList");
const RelatedTrainingList = require("../models/RelatedTrainingList");

const tfjs = require('@tensorflow/tfjs');
const use = require('@tensorflow-models/universal-sentence-encoder');

const ChatMessageController = {};

let useModel;

async function loadUSEModel() {
  useModel = await use.load();
}

// Get all chat messages
const getRecentChatMessages = async (conversation_id, chat_message) => {
  // console.log("getAllChatMessages",conversationId);
  try {
    
    // check Conversation
    const visitorMessages = await ChatMessage.find({
      conversation_id,
      sender_type: "visitor",
      createdAt: { $lt: chat_message.createdAt }
    }).sort({ createdAt: -1 }).limit(2);
   
    const chatMessages = await ChatMessage.find({
      conversation_id,
      createdAt: { 
        $lt: chat_message.createdAt,
        $gte: (visitorMessages[1] && visitorMessages[1].createdAt) || (visitorMessages[0] && visitorMessages[0].createdAt)
      }
    }).sort({ createdAt: 1 });

    return chatMessages;
  } catch (error) {
    console.log("error",error);
    throw error;
  }
};
// Get all chat messages
const getAllChatMessages = async (conversation_id) => {
  // console.log("getAllChatMessages",conversationId);
  try {
    let chatMessages;
    if(conversation_id) {
      chatMessages = await ChatMessage.find({conversation_id})
    }
    else {
      chatMessages = await ChatMessage.find();
    }
    return chatMessages;
  } catch (error) {
    throw error;
  }
};
ChatMessageController.getAllChatMessages = getAllChatMessages;
ChatMessageController.getAllChatMessagesAPI = async (req, res) => {
  try {
    const chatMessages = await getAllChatMessages(req.body.id); //conversationId
    res.json(chatMessages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
};

// Get a single chat message by ID
ChatMessageController.getChatMessageById = async (req, res) => {
  const { id } = req.params;
  try {
    const chatMessage = await ChatMessage.findById(id);
    if (!chatMessage) {
      return res.status(404).json({ error: 'Chat message not found' });
    }
    res.json(chatMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chat message' });
  }
};

// Create a new chat message
const createChatMessage = async(conversation_id, sender, sender_type, message, sources=undefined) => {
  try {
    // console.log({ sender, sender_type, message, conversation_id });
    // console.log("sources", sources);
    const chatMessage = new ChatMessage({
      sender,
      sender_type,
      message,
      conversation_id,
      infoSources: sources
    });
    // console.log("chatMessage",chatMessage);
    await chatMessage.save();
    return chatMessage;
  } catch (error) {
    throw error;
  }
};
ChatMessageController.createChatMessage = createChatMessage;
ChatMessageController.createChatMessageAPI = async (req, res) => {
  const { sender, sender_type, message, conversation_id } = req.body;
  try {
    const chatMessage = await createChatMessage(conversation_id, sender, sender_type, message);
    res.status(201).json(chatMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create chat message' });
  }
};

// Update an existing chat message by ID
ChatMessageController.updateChatMessageById = async (req, res) => {
  const { id } = req.params;
  const { sender, sender_type, message, conversation_id } = req.body;
  try {
    const chatMessage = await ChatMessage.findByIdAndUpdate(
      id,
      { sender, sender_type, message, conversation_id },
      { new: true }
    );
    if (!chatMessage) {
      return res.status(404).json({ error: 'Chat message not found' });
    }
    res.json(chatMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update chat message' });
  }
};

//mark conversation as note
ChatMessageController.addNoteToChat = async (req, res) => {
  const { sender, sender_type, message, conversation_id } = req.body;
  try {
    // const chatMessage = await createChatMessage(conversation_id, sender, sender_type, message);
    const chatMessage = new ChatMessage({
      sender,
      sender_type,
      message,
      conversation_id,
      infoSources: undefined,
      is_note: true
    });
    // console.log("chatMessage",chatMessage);
    await chatMessage.save();
    // return chatMessage;
    res.status(201).json(chatMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create chat message' });
  }
};

//get all notes of conversation
ChatMessageController.getAllChatNotesMessages = async (conversation_id) => {
  try {
    let chatMessagesNotes;
    if(conversation_id) {
      chatMessagesNotes = await ChatMessage.find({conversation_id,is_note:true})
    }
    return chatMessagesNotes;
  } catch (error) {
    throw error;
  }
};


//get all notes of conversation
ChatMessageController.getAllOldChats = async (conversation_id) => {
  try {
    let chatMessagesNotes;
    if(conversation_id) {
      chatMessagesNotes = await ChatMessage.find({conversation_id,is_note:true})
    }
    return chatMessagesNotes;
  } catch (error) {
    throw error;
  }
};

//get all notes of conversation
ChatMessageController.createTag = async (conversation_id) => {
  try {
    let chatMessagesNotes;
    if(conversation_id) {
      chatMessagesNotes = await ChatMessage.find({conversation_id,is_note:true})
    }
    return chatMessagesNotes;
  } catch (error) {
    throw error;
  }
};


// Delete an existing chat message by ID
ChatMessageController.deleteChatMessageById = async (req, res) => {
  const { id } = req.params;
  try {
    const chatMessage = await ChatMessage.findByIdAndDelete(id);
    if (!chatMessage) {
      return res.status(404).json({ error: 'Chat message not found' });
    }
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete chat message' });
  }
};

ChatMessageController.getMessageSources = async (req, res) => {
  const { trainingListIds } = req.body; // Assuming you receive an array of training list IDs
  try {
    // Find training lists directly based on the received IDs
    const trainingLists = await OpenAITrainingList.find({
      _id: { $in: trainingListIds }
    });

    // Respond with the found training lists
    res.json({ trainingLists });
  } catch (error) {
    // Error handling
    res.status(500).json({ error: 'Failed to get training lists' });
  }
};


function isValidJson(jsonString) {
  try {
    JSON.parse(jsonString);
    return true;
  } catch (error) {
    console.log("Not valid json", error);
    return false;
  }
}

const generalInquiryResponse = async (message, userId, chatMessageId) => {
  /*
  if (!useModel) {
    await loadUSEModel();
  }

  // Calculate embeddings for the query message
  const start = Date.now();
  const queryEmbedding = await useModel.embed(message);
  const queryEmbeddingValues = Array.from(queryEmbedding.dataSync());
  const end = Date.now();
  console.log(queryEmbedding, queryEmbeddingValues);

  const similarTrainingLists = await TrainingList.find({
    userId, type:0,
    'mapping.mappingLocation': {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [530,2880] //queryEmbeddingValues,
        },
      },
    },
  }, 'webPage.content webPage.url')
  // .sort({ 'mapping.mappingLocation': -1 })
  .limit(3);

  try {
    const trainingListIds = similarTrainingLists.map(trainingList => trainingList._id);
    const newRelatedTrainingList = new RelatedTrainingList({
      userId,
      chatMessageId,
      message,
      mapping: {
        embedding: queryEmbedding,
        mappingLocation: {
          type: "Point",
          coordinates: queryEmbeddingValues
        },
        mappingDuration: {
          start, end
        }
      },
      trainingListIds,
    });
    const savedRelatedTrainingList = await newRelatedTrainingList.save();
    console.log('New document created:', savedRelatedTrainingList);
  } catch (error) {
    console.error('Error creating document:', error.message);
  }

  const data = {
    info: {
      contents: similarTrainingLists.map(trainingList => trainingList.webPage.content),
    },
    sources: similarTrainingLists.map(trainingList => trainingList.webPage.url)
  };
  */
  try {
    if (!useModel) {
      await loadUSEModel();
    }
    const start = Date.now();
    const queryEmbedding = await useModel.embed(message);
    // const queryEmbeddingValues = Array.from(queryEmbedding.dataSync());
    const queryEmbeddingValues = queryEmbedding.arraySync()[0];
    console.log("queryEmbeddingValues", queryEmbeddingValues);
    const end = Date.now();
  // const pipeline = [
  //   {
  //     $project: {
  //       'webPage.content': 1,
  //       'webPage.url': 1,  // Include the fields you need
  //       similarity: {
  //         $function: {
  //           body: `
  //             function(inputEmbeddingValues, documentEmbeddingValues) {
  //               const calculateCosineSimilarity = (vec1, vec2) => {
  //                 const dotProduct = vec1.reduce((acc, val, i) => acc + val * vec2[i], 0);
  //                 const magnitude1 = Math.sqrt(vec1.reduce((acc, val) => acc + val * val, 0));
  //                 const magnitude2 = Math.sqrt(vec2.reduce((acc, val) => acc + val * val, 0));
                
  //                 return dotProduct / (magnitude1 * magnitude2);
  //               }
  //               const similarity = calculateCosineSimilarity(inputEmbeddingValues, documentEmbeddingValues);
  //               return similarity;
  //             }
  //           `,
  //           args: [queryEmbeddingValues, '$mapping.mappingLocation.coordinates'],
  //           lang: 'js',
  //         },
  //       },
  //     },
  //   },
  //   // {
  //   //   $match: {
  //   //     similarity: { $gt: 0.5 },  // Adjust the similarity threshold as needed
  //   //   },
  //   // },
  //   {
  //     $sort: { similarity: -1 },
  //   },
  //   {
  //     $limit: 3,
  //   },
  // ];

  const pipeline = [
    {
      $match: {
        userId,
        type: 0,
      },
    },
    {
      $unwind: '$webPage.parts', // Unwind the parts array to treat each part separately
    },
    {
      $project: {
        'webPage.content': 1,
        'webPage.url': 1,
        'webPage.parts.content': 1,
        'webPage.parts.embeddingValues': 1,
        similarity: {
          $function: {
            body: `
              function(queryEmbeddingValues, documentEmbeddingValues) {
                const calculateCosineSimilarity = (vec1, vec2) => {
                  const dotProduct = vec1.reduce((acc, val, i) => acc + val * vec2[i], 0);
                  const magnitude1 = Math.sqrt(vec1.reduce((acc, val) => acc + val * val, 0));
                  const magnitude2 = Math.sqrt(vec2.reduce((acc, val) => acc + val * val, 0));
  
                  return dotProduct / (magnitude1 * magnitude2);
                };
  
                const similarity = calculateCosineSimilarity(queryEmbeddingValues, documentEmbeddingValues);
                return similarity;
              }
            `,
            args: [queryEmbeddingValues, '$webPage.parts.embeddingValues'],
            lang: 'js',
          },
        },
      },
    },
    {
      $group: {
        _id: {
          _id: '$_id',
          content: '$webPage.parts.content', // Group by content
        },
        webPage: { $first: '$webPage' }, // Preserve the original webPage object
        similarities: {
          $push: '$similarity', // Collect all similarities for each content group
        },
      },
    },
    {
      $project: {
        _id: '$_id._id',
        content: '$_id.content',
        webPage: 1,
        similarities: { $slice: ['$similarities', 3] }, // Take the top 3 similarities
      },
    },
    {
      $unwind: '$similarities', // Unwind the similarities array
    },
    {
      $sort: { similarities: -1 }, // Sort by similarity in descending order
    },
    {
      $group: {
        _id: '$_id',
        content: { $first: '$content' },
        webPage: { $first: '$webPage' }, // Preserve the original webPage object
        topSimilarities: { $push: '$similarities' }, // Collect the top 3 similarities
      },
    },
    {
      $limit: 3,
    },
  ];
  

  const similarTrainingLists = await TrainingList.aggregate(pipeline).allowDiskUse(true);
  console.log("similarTrainingLists", similarTrainingLists);
  const data = {
    info: {
      // contents: similarTrainingLists.map(trainingList => trainingList.webPage.content),
      contents: similarTrainingLists.map(trainingList => trainingList.content),
    },
    sources: similarTrainingLists.map(trainingList => trainingList.webPage.url)
  };
  return data;
  }
  catch(error) {
    console.log("Finding related info error"+error);
    return {
      info: {
        contents: []
      },
      sources: []
    }
  }
  // const vector = await OpenAIController.createEmbedding(message.toLowerCase());
  // const data = await searchSimilarDocuments(userId, message, 2);
  // const response = {
  //   info: {
  //     // "faqs": {},
  //     contents: data.info
  //   },
  //   sources: data.sources
  // };
  // // console.log("Search response",response);
  // return response;
};

const chat_message_response = async (chatMessage, visitor_id, conversation_id, socket_io, userId) => { 
  const message = chatMessage.message;
  const trainingList = await TrainingList.findOne({
    userId,
    type: 0,
    'mapping.mappingStatus': 2
  }).sort({ createdAt: 1 });
  // const organisation = "SEOKart";
  const organisation = trainingList.webPage.title+": "+trainingList.webPage.metaDescription;
  socket_io.to("visitor"+visitor_id).emit('intermediate-response', {"message":"Retrieving your message"});
  const chat_messages = await getRecentChatMessages(conversation_id, chatMessage);
  let previous_conversation = ""; // There is no previous conversation with this visitor.";
  if(chat_messages.length) {
    previous_conversation = "We are already having the following conversation with this visitor: \n";
  }
  for (const chat_message of chat_messages) {
    switch(chat_message.sender_type)
    {
      case "visitor":
        previous_conversation += `  <message sender="visitor">${chat_message.message}</message>
`;
      break;
      case "bot":
        previous_conversation += `  <message sender="responder">${chat_message.message}</message>
`;
      break;
    }
  }
  
  try {
    /* ----- 1st API for finding enquiries with context and intents ----- */
    const gptFn_replies_for_enquiries = {
      "name": "replies_for_enquiries",
      "description": "Finding replies for enquiries as per their intents.",
      "parameters": {
        "type": "object",
        "properties": {
          "enquiries": {
            "type": "array",
            "description": "A list of enquiries and their most appropriate intents.",
            "items": {
                "type": "object",
                "properties": {
                    "enquiry_text": {
                        "type": "string",
                        "description": "The enquiry, which has a clear and independent meaning."
                    },
                    "intent": {
                        "type": "string",
                        "description": "The most appropriate intent for the corresponding enquiry.",
                        "enum": ["greeting", "gibberish", "general_enquiry", "unclear"]
                    }
                },
                "required": ["enquiry_text", "intent"]
            }
          },
          "last_subject": {
            "type": "string",
            "description": "The subject about which conversation was going on in last message. If there are more than one subject, then provide those in a comma seperated string."
          }
        },
        "required": ["enquiries", "last_subject"]
      }
    };
// mentioned    
let incoming_conversation = [
{role: "system", content: `Extract and Identify Enquiries with their Intents and Last Subject of Previous Conversation

Task: You need to analyze a visitor's message, identify different enquiries along with their corresponding intents, and also include the task of retrieving the last topic that was discussed in the previous conversation.
Input: visitor_message, previous_conversation (Given in respective XML tags).
Output: enquiries, last_subject (These will be sent to "replies_for_enquiries" function).

Procedure:

Step 1: Identify last_subject in previous_conversation:
Identify the last_subject underlying in the very last message of the previous_conversation to understand the context and subject matter of the ongoing conversation. Even if not explicitly mentioned, the last_subject will naturally influence the current discussion. If multiple subjects arise, you can provide them as a comma-separated string. If there is no previous_conversation, please provide a blank string for last_subject.

Step 2: Create first draft of enquiries (In JSON format):
- Initially, consider a blank list for enquiries.
- Understand the visitor_message on the basis of previous_conversation. 
- previous_conversation is only for reference, do not include any enquiry from previous_conversation.
- Identify the all distinct main enquiries from the visitor_message.
- Add contextual information.
- Replace pronouns with appropriate descriptions based on the context.
- Remove non-essential lead-in enquiries, for which separate response is not needed.
- Rephrase each enquiry to make them shorter with keeping all information unchanged.

Step 3: Pair each enquiry with one of the following limited intents to create second draft of enquiries:
"greeting" - Use this intent for messages containing greetings or initial salutations.
"gibberish" - Assign this intent to messages that are difficult to interpret.
"general_enquiry" - Utilize this intent for general questions or enquiries without specific intent or the general question even if the detail is missing.
"unclear" - Apply this intent for any other types of enquiries that don't fit into the above categories.

Step 4: Final enquiries, after re-confirmation with visitor_message:
- Ensure each enquiry has a clear and independent meaning.
- Make sure that we are having all main enquiries which are needed to be answered in visitor_message.
- Each enquiry is having most appropriate intent from limited intents provided.

Step 5: Final Result:
Provide the final enquiries and last_subject.

Ensure to follow these steps carefully to achieve accurate results for the given task.

Example 1:

**Input:**
<visitor_message>
Hello, good morning! I'm interested in your products. 
Can you tell me more about them?
</visitor_message>

<previous_conversation>
</previous_conversation>

**Output (Expected Result):**
{
  "enquiries": [
    {
      "enquiry_text": "Hello, good morning",
      "intent": "greeting"
    },
    {
      "enquiry_text": "Can you tell me more about your products?",
      "intent": "general_enquiry"
    }
  ],
  "last_subject": ""
}

Example 2:

**Input:**
<visitor_message>
and price?
</visitor_message>

<previous_conversation>
  <message sender="visitor">What are the color options available in it?</message>
  <message sender="responder">We offer this shirt in black, white, and blue.</message>
  <message sender="visitor">medium size and blue color?</message>
  <message sender="responder">Yes, we do have the shirt in medium size available in blue color.</message>
</previous_conversation>

**Output (Expected Result):**
{
  "enquiries": [
    {
      "enquiry_text": "What is the price of the shirt in medium size and blue color?",
      "intent": "general_enquiry"
    }
  ],
  "last_subject": "shirt in medium size and blue color"
}
`},
{role: "user", content:`<visitor_message>
${message}
</visitor_message>

<previous_conversation>
${previous_conversation}</previous_conversation>`}];

    /* ----- Processing 1st API result and finding appropriate information ----- */

    // "enum": ["product-inquiries", "order-status", "return-and-exchanges", "payment-and-billing", "shipping-and-delivery", "account-management", "website-navigation", "technical-support", "promotions-and-discounts", "store-setup-and-customization", "marketing-and-seo", "none", "other"]
    
    let queue, queue_id;
    socket_io.to("visitor"+visitor_id).emit('intermediate-response', {"message":"Analysing your message"});
    queue = await OpenAIQueueController.createOpenAIQueue("chat", "respondChat", visitor_id, chatMessage._id, incoming_conversation, [
      {
        "type": "function",
        "function": gptFn_replies_for_enquiries
      }
    ], {"type": "function", "function":{"name": "replies_for_enquiries"}}, 0, 0, "pending");
    queue_id = queue._id.toString();
    // console.log("waiting for response from openai");
    let response = await OpenAIQueueController.waitForTaskCompletion(queue_id);
    // console.log("Data after 1st openai call", response);
    // let response = await OpenAIController.respondLargeChat(incoming_conversation, [
    //   gptFn_replies_for_enquiries
    // ], {"name": "replies_for_enquiries"}, 0, 0); // "auto" {"name": "replies_for_enquiries"}

      let relevant_information = '';
      let relevantSources = [];
      let replyObj = {
          "reply": 'Undefined Value',
          "pending": true
      };

    let functionName = response.tool_calls[0].function.name.trim(); //function_call.name.trim();
    let enquiries = [];
    // let relatedInformation = [];
    let last_subject = "Last subject is not specified.";
    if(isValidJson(response.tool_calls[0].function.arguments)) { // .function_call.arguments
      const arguments = JSON.parse(response.tool_calls[0].function.arguments);
      if(arguments.enquiries) {
        for (const enquiry of arguments.enquiries) {
          switch(enquiry.intent)
          {
            case "greeting": 
              enquiries.push({"enquiry_text":enquiry.enquiry_text, "potential_information": {}, "enquiry_guidelines": "Politely greet in cheerful manner with telling about organisation and major services."});
            break;
            case "gibberish": 
              enquiries.push({"enquiry_text":enquiry.enquiry_text, "potential_information": {}, "enquiry_guidelines": "Politely deny that you couldn't understand and ask to rewrite the enquiry."});
            break;
            case "unclear": 
              enquiries.push({"enquiry_text":enquiry.enquiry_text, "potential_information": {}, "enquiry_guidelines": "Politely ask to clarify the enquiry and ask to provide more detail."});
            break;
            case "general_enquiry":
              socket_io.to("visitor"+visitor_id).emit('intermediate-response', {"message":"Searching for relevant information"});
              let enquiry_message = enquiry.enquiry_text;
              if(arguments.last_subject) {
                enquiry_message = "My previous message was about "+arguments.last_subject+". "+enquiry.enquiry_text;
                last_subject = "Previous message was about "+arguments.last_subject;
              }
              const related_data = await generalInquiryResponse(enquiry_message, userId, chatMessage._id);
              relevant_information = related_data.info; 
              relevantSources = [...relevantSources, ...(related_data.sources)];
              console.log(relevantSources);
              enquiries.push({"enquiry_text":enquiry_message, "potential_information": relevant_information, "enquiry_guidelines": ""});    
              // relatedInformation.push(related_data);
            break;
            default:
          }
        }
      }
      else {
        throw "Invalid response while analysing data using GPT (enquiries missing)";
      }    
    }
    else {
      throw "Invalid response while analysing data using GPT (invalid JSON)";
    }

    /* ----- 2nd API for finding chat message reply using provided information ----- */
    const gptFn_store_reply = {
      "name": "store_reply",
      "description": "Store the reply",
      "parameters": {
          "type": "object",
          "properties": {
            "enquiry_replies": {
              "type": "array",
              "description": "A list of enquiries, their replies and references of the replies.",
              "items": {
                  "type": "object",
                  "properties": {
                      "enquiry": {
                          "type": "string",
                          "description": "The enquiry."
                      },
                      "reply_text": {
                          "type": "string",
                          "description": "The reply text."
                      },
                      "citation": {
                          "type": "string",
                          "description": `The citation. It can be guidelines, faqs, contents, key_details as given.`
                      }
                  },
                  "required": ["enquiry", "enquiry_reply", "citation"]
              }
            },
            "chat_reply": {
                "type": "string",
                "description": "The concise chat reply in HTML format, which can be nested in any <div> tag with appropriate <li>, <a>, <p> tags. If it is longer, then logically divide in multiple paragraphs using <p> tags. Keeping it within 2 to 5 sentences is usually a good range."
            }
          },
          "required": ["enquiry_replies", "chat_reply"],
      }
    };
    
// console.log("enquiries", enquiries);
let information_based_enquiries = '';
let task_based_enquiries = '';
for (const enquiry of enquiries) { // enquiry.potential_information.faqs || 
  if(enquiry.potential_information && (enquiry.potential_information.contents)) {
    information_based_enquiries += `<enquiry>
    <enquiry_text>`+enquiry.enquiry_text+`</enquiry_text>`;
    // <faqs>`;
    // for (const faq of enquiry.potential_information.faqs) {
    //   information_based_enquiries += `
    //     <faq>
    //       <question>`+faq.question+`</question>
    //       <answer>`+faq.answer+`</answer>
    //     </faq>`;
    // }
    // information_based_enquiries += `
    // </faqs>
    information_based_enquiries += `<contents>`;
    for (const content of enquiry.potential_information.contents) {
      information_based_enquiries += `
        <html_content>`+content+`</html_content>`;
    }
    information_based_enquiries += `
    </contents>
  </enquiry>`;
  }
  else if(enquiry.enquiry_guidelines) {
    task_based_enquiries += `<enquiry>
    <enquiry_text>`+enquiry.enquiry_text+`</enquiry_text>
    <guideline>`+enquiry.enquiry_guidelines+`</guideline>
  </enquiry>`;
  }
}
// console.log("information_based_enquiries", information_based_enquiries);
// console.log("task_based_enquiries", task_based_enquiries);

let extended_conversation = [
{role: "system", content: `Crafting Engaging Chat Reply for Visitor's Message Based on Provided Information and Guidelines, While Storing Separate Reply and Citation for Each Enquiry

Task: You need to create a concise and engaging chat reply in response to the visitor's message with ensuring an effective and minimalistic reply while maintaining a professional tone and reflecting our brand identity.
Input: visitor_message, task_based_enquiries, information_based_enquiries, previous_conversation (Given in respective XML tags).
Output: enquiry_replies, chat_reply (These will be sent to "store_reply" function).

Step 1: Review the previous_conversation:
Examine the ongoing conversation in the previous_conversation to understand the context and subject matter, identifying key_details that can help in addressing the visitor_message effectively.

Step 2: Analyze task_based_enquiries and craft their replies to create first draft of enquiry_replies:
Initially, consider a blank list for enquiry_replies. For each enquiry in the task_based_enquiries, which includes enquiry_text and guidelines, follow the respectively provided guidelines with key_details to craft a focused and helpful reply_text for that enquiry. Push these enquiries with their respective reply_text and citation (guidelines, key_details) in to enquiry_replies. 

Step 3: Analyze and Refine information_based_enquiries:
Use key_details and thoroughly examine each enquiry in the information_based_enquiries, which includes enquiry_text, faqs and contents. Focus on extracting relevant details essential to address the respective enquiries while filtering out irrelevant information.

Step 4: Craft replies for information_based_enquiries to create final enquiry_replies:
For each enquiry in information_based_enquiries, use key_details and their relevant faqs and contents to create a concise and informative reply_text. If no relevant faqs/contents are available, create reply_text to provide a polite response stating that relevant information couldn't be found in the database. Push these enquiries with their respective reply_text and citation (faqs, contents, key_details) in to enquiry_replies.

Step 5: Compose first draft of chat_reply:
Craft a final chat_reply for visitor_message by the logical combination of all the reply_text from enquiry_replies, without using any other knowledge. Ensure the response is as small as possible while addressing all relevant aspects of visitor_message. You are not answerable for all the questions. You can politely deny for enquiries, if no relevant information found in database. Use a friendly tone and concise language to provide a seamless chat experience.

Step 6: Final chat_reply, after creating more user engagement:
Rephrase the chat_reply in smallest reply with representing customer support team of the organisation (`+organisation+`) in responses for visitor_message.
- Use "We, I, us" for representing the organisation to answer on their behalf. 
- Prioritizes the organization's interests, maintains a professional tone. 
- Includes emojis for engagement. 
- The response should be formatted in HTML with shorter paragraphs, lists, hyperlinked URLs, and "mailto:" protocol for email addresses.
- Make sure to have follow-up message for assisting further.

Step 7: Final Result:
Provide the final enquiry_replies and chat_reply.

Ensure to follow these steps carefully to achieve accurate results for the given task.
`},

{role: "user", content:`
<visitor_message>
${message}
</visitor_message>

<task_based_enquiries>
${task_based_enquiries}
</task_based_enquiries>

<information_based_enquiries>
${information_based_enquiries}
</information_based_enquiries>

<previous_conversation>
${previous_conversation}</previous_conversation>`}];

// <enquiries_json>
// `+JSON.stringify(enquiries_responses)+`
// </enquiries_json>

    socket_io.to("visitor"+visitor_id).emit('intermediate-response', {"message":"Crafting a helpful response for you"});
    queue = await OpenAIQueueController.createOpenAIQueue("chat", "respondLargeChat", visitor_id, chatMessage._id, extended_conversation, [
        // gptFn_replies_for_enquiries,
        {
          "type": "function",
          "function": gptFn_store_reply
        }
      ], {"type": "function", "function":{"name": "store_reply"}}, 1, 0.5, "pending"); // 1, 0.5
    queue_id = queue._id.toString();
    // console.log("waiting for response from openai");
    response = await OpenAIQueueController.waitForTaskCompletion(queue_id);
    // console.log("final response", response);
    // await OpenAIController.respondLargeChat(extended_conversation, [
    //   gptFn_replies_for_enquiries,
    //   gptFn_store_reply
    // ], {"name": "store_reply"}, 1, 0.5);

    socket_io.to("visitor"+visitor_id).emit('intermediate-response', {"message":"Almost done"});

    if(isValidJson(response.tool_calls[0].function.arguments)) {
      const arguments = JSON.parse(response.tool_calls[0].function.arguments);
      if(arguments && arguments.chat_reply) {
        replyObj.reply = arguments.chat_reply;
        replyObj.infoSources = relevantSources;
        replyObj.pending = undefined;
      }
      else
      {
          replyObj.reply = "AI couldn't find reply in this attempt.";
          replyObj.infoSources = relevantSources;
          replyObj.pending = false;
      }
    }
    
    replyObj.chatCompletions = "done"; // chatCompletion;
    replyObj.pending = undefined;
    return replyObj;
  }
  catch(err)
  {
      console.log("Error in finding response from GPT", err);
      const replyObj = {
          "error": err,
          "reply": "Error in finding response from GPT"
      };
      return replyObj;
  }
  return;
};
ChatMessageController.incoming_chat_message = (socket_io) => asyncHandler(async (req, res, next) => { 
  
  const {chatMessage, userId} = req.body;
  let visitor_id, conversation_id;
  const response_data = await chat_message_response(chatMessage, visitor_id, conversation_id, socket_io, userId);
  if(response_data)
  {
      res.json(response_data);
  }
  else
  {
      res.json({
          "reply": "API failed"
      });
  }
});
ChatMessageController.chat_message_response = async (chatMessage, visitor_id, conversation_id, socket_io, userId) => {
  return await chat_message_response(chatMessage, visitor_id, conversation_id, socket_io, userId);
};

module.exports = ChatMessageController;
