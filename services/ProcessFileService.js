const { pineconeTrainQueue } = require("./TrainData");
const {readFileContent} = require("./FileType"); // Assuming you have a function to read file content

async function processFileOrSnippet(data) {
  try {
    if (data.type == 1) { //file
      let content = await readFileContent(data.file.path, data.file.mimetype);
      await pineconeTrainQueue.add("pineconeTraining", {
        type: data.type,
        title: data.file.originalname,
        content,
        // fileName: data.fileName,
        // userId: data.userId,
        // originalFileName: data.originalFileName,
        pineconeIndexName:data.pineconeIndexName,
        trainingListId:data.trainingListId,
      }); // Job Name and data

      return {
        success: true,
        content,
      };
    }

    if (data.type == 2) { //snippet
      await pineconeTrainQueue.add("pineconeTraining", {
        type: data.type,
        title: data.title,
        content:data.content,
        // userId: data.userId,
        pineconeIndexName: data.pineconeIndexName,
        trainingListId: data.trainingListId,
      }); // Job Name and data

      return {
        success: true,
      };
    }

    if (data.type == 3) { //faq
      await pineconeTrainQueue.add("pineconeTraining", {
        type: data.type,
        title: data.title,
        content:data.content,
        // userId: data.userId,
        pineconeIndexName: data.pineconeIndexName,
        trainingListId: data.trainingListId,
      }); // Job Name and data

      return {
        success: true,
      };
    }
  } catch (error) {
    console.error("Error processing file/snippet:", error);
    return { success: false, error };
  }
}

module.exports = {
  processFileOrSnippet,
};
