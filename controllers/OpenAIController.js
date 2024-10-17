const OpenAIUsageController = require('./OpenAIUsageController');
// const { Configuration, OpenAIApi } = require("openai");

// const {apiKey} = require('../config/openai');
// const configuration = Configuration({apiKey: apiKey});
// const openai = new OpenAIApi(configuration);


const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY || '';
// console.log("apiKey",apiKey);
const OpenAI = require("openai");
const openai = new OpenAI({
    apiKey: apiKey
});

const OpenAIController = {};

// Create a new embedding: Embedding Ada v2
const createEmbedding = async (input) => {
    try {
        const request = {
            model: "text-embedding-3-small",
            // "text-embedding-ada-002",
            input,
            encoding_format: "float",
        };
        const response = await openai.embeddings.create(request);

        const response_object = JSON.parse(JSON.stringify(response));
        // console.log("response_object", response_object);
        await OpenAIUsageController.createOpenAIUsage(request,response_object, "text-embedding-3-small");
        
        return response.data; // [0].embedding;
    } catch (error) {
        throw error; // Rethrow the error or handle it further up the call stack
    }
};
OpenAIController.createEmbedding = createEmbedding;
OpenAIController.createEmbeddingAPI = async (req, res) => {
    try {
        const embedding = await createEmbedding(req.body.input);
        res.json(embedding);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create embedding' });
    }
};

// Create a new chat completion: GPT-3.5 Turbo 4K
const respondChat = async (messages, tools, tool_choice, temperature, frequency_penalty) => {
    try {
        const request = {
            model: "gpt-3.5-turbo-0125",    //"gpt-3.5-turbo"
            messages,
            tools,
            tool_choice,
            temperature,
            // presence_penalty,
            frequency_penalty,
            // response_format: { "type": "json_object" }
        };
        // const response = await openai.createChatCompletion(request);
        const response = await openai.chat.completions.create(request);
        console.log("response", response);
        const response_object = JSON.parse(JSON.stringify(response));
        await OpenAIUsageController.createOpenAIUsage(request,response_object, "GPT-3.5 Turbo");
        
        return response.choices[0].message;
    } catch (error) {
        throw error; // Rethrow the error or handle it further up the call stack
    }
};
OpenAIController.respondChat = respondChat;
OpenAIController.respondChatAPI = async (req, res) => {
    const {messages, tools, tool_choice, temperature, frequency_penalty} = req.body;
    try {
        const message = await respondChat(messages, tools, tool_choice, temperature, frequency_penalty);
        res.json(message);
    } catch (error) {
        res.status(500).json({ error: 'Failed to respond chat' });
    }
};


// Create a new chat completion: GPT-3.5 Turbo 16K
const respondLargeChat = async (messages, tools, tool_choice, temperature, frequency_penalty) => {
    try {
        const request = {
            model: "gpt-3.5-turbo-0125",     //"gpt-3.5-turbo-16k"
            messages,
            tools,
            tool_choice,
            temperature,
            // presence_penalty,
            frequency_penalty
        };
        // const response = await openai.createChatCompletion(request);
        const response = await openai.chat.completions.create(request);

        const response_object = JSON.parse(JSON.stringify(response));
        await OpenAIUsageController.createOpenAIUsage(request,response_object, "GPT-3.5 Turbo");
        
        return response.choices[0].message;
    } catch (error) {
        throw error; // Rethrow the error or handle it further up the call stack
    }
};
OpenAIController.respondLargeChat = respondLargeChat;
OpenAIController.respondLargeChatAPI = async (req, res) => {
    const {messages, tools, tool_choice, temperature, frequency_penalty} = req.body;
    try {
        const message = await respondLargeChat(messages, tools, tool_choice, temperature, frequency_penalty);
        res.json(message);
    } catch (error) {
        res.status(500).json({ error: 'Failed to respond chat' });
    }
};


module.exports = OpenAIController;