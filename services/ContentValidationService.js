const PlanService = require("./PlanService");

class ContentValidationService {
  
  // Minimum content lengths for each type
  static MIN_LENGTHS = {
    snippet: 50,
    file: 100,
    faq: 30,
    webpage: 200
  };

  // Maximum content lengths for each type
  static MAX_LENGTHS = {
    snippet: 100000,  // 100KB
    file: 10000000,   // 10MB
    faq: 10000,       // 10KB
    webpage: 5000000  // 5MB
  };

  /**
   * Validate content before processing
   * @param {string} content - The content to validate
   * @param {string} type - Type of content (snippet, file, faq, webpage)
   * @param {string} userId - User ID
   * @returns {Object} Validation result
   */
  static async validateContent(content, type, userId) {
    try {
      // Check if content exists
      if (!content || typeof content !== 'string') {
        return {
          isValid: false,
          error: "Content is required and must be a string",
          errorCode: "CONTENT_MISSING"
        };
      }

      const trimmedContent = content.trim();
      
      // Check minimum length
      const minLength = this.MIN_LENGTHS[type] || 50;
      if (trimmedContent.length < minLength) {  
        return {
          isValid: false,
          error: `Content is too short. Minimum ${minLength} characters required for ${type}.`,
          errorCode: "CONTENT_TOO_SHORT",
          currentLength: trimmedContent.length,
          requiredLength: minLength
        };
      }

      // Check maximum length
      // const maxLength = this.MAX_LENGTHS[type] || 100000;
      // if (trimmedContent.length > maxLength) {
      //   return {
      //     isValid: false,
      //     error: `Content is too long. Maximum ${maxLength} characters allowed for ${type}.`,
      //     errorCode: "CONTENT_TOO_LONG",
      //     currentLength: trimmedContent.length,
      //     maxLength: maxLength
      //   };
      // }

      // Check for meaningful content (not just whitespace or repeated characters)
      if (!this.hasMeaningfulContent(trimmedContent)) {
        return {
          isValid: false,
          error: "Content appears to be empty or contains only whitespace/repeated characters",
          errorCode: "CONTENT_NOT_MEANINGFUL"
        };
      }

      // Check plan limits
      const contentSize = Buffer.byteLength(trimmedContent, 'utf8');
      const sizeCheck = await PlanService.checkDataSizeLimit(userId, contentSize);
      
      if (!sizeCheck) {
        return {
          isValid: false,
          error: "Content size exceeds your plan limit",
          errorCode: "PLAN_LIMIT_EXCEEDED",
          // sizeInfo: sizeCheck
        };
      }

      // Check for potential spam content
      const spamCheck = this.checkForSpam(trimmedContent);
      if (!spamCheck.isValid) {
        return {
          isValid: false,
          error: spamCheck.error,
          errorCode: "SPAM_DETECTED"
        };
      }

      return {
        isValid: true,
        contentSize,
        cleanContent: trimmedContent,
        // wordCount: this.getWordCount(trimmedContent),
        // estimatedTokens: this.estimateTokens(trimmedContent)
      };

    } catch (error) {
      console.error("Error validating content:", error);
      return {
        isValid: false,
        error: "Validation failed due to internal error",
        errorCode: "VALIDATION_ERROR"
      };
    }
  }

  /**
   * Check if content has meaningful text
   * @param {string} content - Content to check
   * @returns {boolean} Whether content is meaningful
   */
  static hasMeaningfulContent(content) {
    // Remove excessive whitespace
    const normalized = content.replace(/\s+/g, ' ').trim();
    
    // Check if content is just repeated characters
    const uniqueChars = new Set(normalized.toLowerCase().replace(/\s/g, ''));
    if (uniqueChars.size < 5) {
      return false;
    }

    // Check for minimum word count
    const wordCount = this.getWordCount(normalized);
    if (wordCount < 5) {
      return false;
    }

    // Check for reasonable character distribution
    const alphaCount = (normalized.match(/[a-zA-Z]/g) || []).length;
    const alphaRatio = alphaCount / normalized.length;
    
    if (alphaRatio < 0.3) { // At least 30% alphabetic characters
      return false;
    }

    return true;
  }

  /**
   * Check for spam content
   * @param {string} content - Content to check
   * @returns {Object} Spam check result
   */
  static checkForSpam(content) {
    const lowerContent = content.toLowerCase();
    
    // Check for excessive repetition
    const words = lowerContent.split(/\s+/);
    const wordFreq = {};
    
    words.forEach(word => {
      if (word.length > 2) { // Only count words longer than 2 characters
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });

    // Check if any word appears more than 30% of the time
    const totalWords = words.length;
    for (const [word, count] of Object.entries(wordFreq)) {
      if (count / totalWords > 0.3) {
        return {
          isValid: false,
          error: `Content contains excessive repetition of the word "${word}"`
        };
      }
    }

    // Check for excessive punctuation
    const punctuationCount = (content.match(/[!?]{2,}/g) || []).length;
    if (punctuationCount > 5) {
      return {
        isValid: false,
        error: "Content contains excessive punctuation"
      };
    }

    // Check for excessive caps
    const capsCount = (content.match(/[A-Z]/g) || []).length;
    const capsRatio = capsCount / content.length;
    if (capsRatio > 0.5 && content.length > 100) {
      return {
        isValid: false,
        error: "Content contains excessive capital letters"
      };
    }

    return { isValid: true };
  }

  /**
   * Get word count
   * @param {string} content - Content to count
   * @returns {number} Word count
   */
  static getWordCount(content) {
    return content.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Estimate token count (rough approximation)
   * @param {string} content - Content to estimate
   * @returns {number} Estimated token count
   */
  static estimateTokens(content) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(content.length / 4);
  }

  /**
   * Validate FAQ specifically
   * @param {string} question - FAQ question
   * @param {string} answer - FAQ answer
   * @param {string} userId - User ID
   * @returns {Object} Validation result
   */
  static async validateFAQ(question, answer, userId) {
    if (!question || !answer) {
      return {
        isValid: false,
        error: "Both question and answer are required",
        errorCode: "FAQ_INCOMPLETE"
      };
    }

    const questionValidation = await this.validateContent(question, 'faq', userId);
    if (!questionValidation.isValid) {
      return {
        ...questionValidation,
        field: 'question'
      };
    }

    const answerValidation = await this.validateContent(answer, 'faq', userId);
    if (!answerValidation.isValid) {
      return {
        ...answerValidation,
        field: 'answer'
      };
    }

    const combinedContent = `Question: ${question}\nAnswer: ${answer}`;
    const combinedValidation = await this.validateContent(combinedContent, 'faq', userId);
    
    return {
      ...combinedValidation,
      questionWordCount: this.getWordCount(question),
      answerWordCount: this.getWordCount(answer)
    };
  }

  /**
   * Validate file content
   * @param {string} content - File content
   * @param {string} filename - Original filename
   * @param {string} userId - User ID
   * @returns {Object} Validation result
   */
  static async validateFile(content, filename, userId) {
    const validation = await this.validateContent(content, 'file', userId);
    
    if (!validation.isValid) {
      return validation;
    }

    // Additional file-specific validations
    const fileExtension = filename.split('.').pop().toLowerCase();
    const supportedExtensions = ['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
    
    if (!supportedExtensions.includes(fileExtension)) {
      return {
        isValid: false,
        error: `File type .${fileExtension} is not supported`,
        errorCode: "UNSUPPORTED_FILE_TYPE"
      };
    }

    return {
      ...validation,
      fileExtension,
      filename
    };
  }
}

module.exports = ContentValidationService;