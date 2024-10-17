const OpenAIQueue = require('../models/OpenAIQueue');
const OpenAIController = require("./OpenAIController");

const OpenAIQueueController = {};
let callTimestamps = [];
let responseTimestamps = [];
let processing = false;
let processingQueueSet = false;
let queueSetAvailable = true;
let queueEnabled = true;
const MAX_CALLS_PER_MINUTE = 40;
const taskStatus = {};
const enableProcessQueue = () => {
  // queueEnabled = false;
  queueSetAvailable = true;
  processQueue();
};
const processQueueElement = async(queue) => {
  const {_id, controller_function_name, messages, tools, tool_choice, temperature, frequency_penalty} = queue;
  const queue_id = _id.toString(); // Convert MongoDB ObjectID to a string as our unique task identifier
  let response;

  switch(controller_function_name) {
    case "respondChat":
      response = await OpenAIController.respondChat(messages, tools, tool_choice, temperature, frequency_penalty);
    break;
    case "respondLargeChat":
      response = await OpenAIController.respondLargeChat(messages, tools, tool_choice, temperature, frequency_penalty);
    break;
  }
  // Mark the task as resolved
  if(taskStatus[queue_id])
  {
    taskStatus[queue_id].status = "resolved";
    taskStatus[queue_id].data = response;
  }
  else {
    taskStatus[queue_id] = {"status": "resolved", "data": response};
  }
  await OpenAIQueue.findByIdAndUpdate(_id, { $set: { status: 'completed' } });
  responseTimestamps.push(Date.now());
  setTimeout(enableProcessQueue, 60*1000);
}

const processQueue = async() => {
  console.log("inside process","processingQueueSet",processingQueueSet,"processing",processing,"queueSetAvailable",queueSetAvailable);
  if (processingQueueSet || (processing && !queueSetAvailable)) return; 
  // If already processing, and queueSet not Available; then no need to start it again

  processingQueueSet = true;
  processing = true;
  try {
    console.log("inside process try");

    const currentTimestamp = Date.now();
    // callTimestamps.push(currentTimestamp);
    const oneMinuteAgo = currentTimestamp - 60 * 1000; // 60 seconds * 1000 milliseconds
    callTimestamps = callTimestamps.filter((timestamp) => timestamp > oneMinuteAgo);
    responseTimestamps = responseTimestamps.filter((timestamp) => timestamp > oneMinuteAgo);
    const apiCountWithinMinute = callTimestamps.length > responseTimestamps.length ? callTimestamps.length: responseTimestamps.length;
    console.log("apiCountWithinMinute", apiCountWithinMinute);
    const remainingCallCount = MAX_CALLS_PER_MINUTE - apiCountWithinMinute;
    console.log("remainingCallCount", remainingCallCount);
    if(remainingCallCount<=0)
    {
        queueSetAvailable = false;
        processingQueueSet = false;
        return;
    }
    // const queue = await OpenAIQueue.findOneAndDelete({}).sort({ createdAt: 1 });
    // if (!queue) {
    //   processing = false;
    //   return;
    // }

    const queuesToUpdate = await OpenAIQueue.find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(remainingCallCount);

    if (queuesToUpdate.length === 0) {
      console.log('No pending records found.');
      processing = false;
      processingQueueSet = false;
      return;
    }

    
    // Update the status of the fetched records to "processing"
    await OpenAIQueue.updateMany({ _id: { $in: queuesToUpdate.map(record => record._id) } }, { $set: { status: 'processing' } });
    for (const queue of queuesToUpdate) {
      callTimestamps.push(currentTimestamp);
    }
    if(remainingCallCount==queuesToUpdate.length)
    {
      queueSetAvailable = false;
      processingQueueSet = false;
    }
    else {
      processingQueueSet = false;
      setTimeout(processQueue, 1000);
    }
    
    

    await Promise.all(queuesToUpdate.map(processQueueElement));
    
    // processing = false;
    // processQueue(); // Process the next item in the queue
  } catch (error) {
    processing = false;
    console.error("Error processing request:", error);
    // processQueue(); // Process the next item in the queue
  }
  // setTimeout(enableProcessQueue, 60000 / MAX_CALLS_PER_MINUTE);
  setTimeout(processQueue, 5000);
};

OpenAIQueueController.waitForTaskCompletion = (queue_id) => {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if(!taskStatus[queue_id]) {
        clearInterval(interval);
        reject("Queued task is not found.");
      }
      if (taskStatus[queue_id].status === 'resolved') {
        clearInterval(interval);
        resolve(taskStatus[queue_id].data);
      } 
      else if (taskStatus[queue_id].status === 'rejected') {
        clearInterval(interval);
        reject(taskStatus[queue_id].data);
      }
    }, 100); // Check every 100ms if the task is completed
  });
};

// Get all OpenAI queues
OpenAIQueueController.getAllOpenAIQueues = async (req, res) => {
  try {
    const queues = await OpenAIQueue.find();
    res.json(queues);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch OpenAI queues' });
  }
};

// Get a single OpenAI queue by ID
OpenAIQueueController.getOpenAIQueueById = async (req, res) => {
  const { id } = req.params;
  try {
    const queue = await OpenAIQueue.findById(id);
    if (!queue) {
      return res.status(404).json({ error: 'OpenAI queue not found' });
    }
    res.json(queue);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch OpenAI queue' });
  }
};

const createOpenAIQueue = async (queue_type, controller_function_name, visitor_id, chat_message_id, messages, tools, tool_choice, temperature, frequency_penalty, status) => {
    try {
      let queue;
      if(visitor_id) {
        queue = new OpenAIQueue({
          queue_type,
          controller_function_name,
          visitor_id,
          chat_message_id,
          messages,
          tools,
          tool_choice,
          temperature,
          frequency_penalty,
          status,
        });
      }
      else {
        queue = new OpenAIQueue({
          queue_type,
          controller_function_name,
          messages,
          tools,
          tool_choice,
          temperature,
          frequency_penalty,
          status,
        });
      }
        await queue.save();
        const queue_id = queue._id.toString();
        taskStatus[queue_id] = {"status":"pending", "data":false};
        processQueue();
        return queue;
    } catch (error) {
        throw error;
    }
};
// Create a new OpenAI queue
OpenAIQueueController.createOpenAIQueue = createOpenAIQueue;
OpenAIQueueController.createOpenAIQueueAPI = async (req, res) => {
  const {
    queue_type,
    controller_function_name,
    visitor_id,
    chat_message_id,
    messages,
    tools,
    tool_choice,
    temperature,
    frequency_penalty,
    status,
  } = req.body;
  try {
    const queue = await createOpenAIQueue(queue_type, controller_function_name, visitor_id, chat_message_id, messages, tools, tool_choice, temperature, frequency_penalty, status);
    res.status(201).json(queue);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create OpenAI queue' });
  }
};

// Update an existing OpenAI queue by ID
OpenAIQueueController.updateOpenAIQueueById = async (req, res) => {
  const { id } = req.params;
  const {
    queue_type,
    controller_function_name,
    visitor_id,
    chat_message_id,
    messages,
    tools,
    tool_choice,
    temperature,
    frequency_penalty,
    status,
  } = req.body;
  try {
    const queue = await OpenAIQueue.findByIdAndUpdate(
      id,
      {
        queue_type,
        controller_function_name,
        visitor_id,
        chat_message_id,
        messages,
        tools,
        tool_choice,
        temperature,
        frequency_penalty,
        status,
      },
      { new: true }
    );
    if (!queue) {
      return res.status(404).json({ error: 'OpenAI queue not found' });
    }
    res.json(queue);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update OpenAI queue' });
  }
};

// Delete an existing OpenAI queue by ID
OpenAIQueueController.deleteOpenAIQueueById = async (req, res) => {
  const { id } = req.params;
  try {
    const queue = await OpenAIQueue.findByIdAndDelete(id);
    if (!queue) {
      return res.status(404).json({ error: 'OpenAI queue not found' });
    }
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete OpenAI queue' });
  }
};

module.exports = OpenAIQueueController;
