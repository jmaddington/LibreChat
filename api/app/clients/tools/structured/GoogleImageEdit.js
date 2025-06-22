const { z } = require('zod');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { logAxiosError } = require('@librechat/api');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { FileContext, ContentTypes, EImageOutputType } = require('librechat-data-provider');
const { logger } = require('~/config');

const displayMessage =
  'Google Imagen displayed an image. All generated images are already plainly visible, so don\'t repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.';

/** Default prompt descriptions */
const DEFAULT_PROMPT_DESCRIPTION = `Describe the changes you want to make to the image in detail.
  Be highly specific about what aspects you want to modify:
  (1) what elements to add, remove, or change,
  (2) how to alter composition or positioning,
  (3) desired lighting or mood changes,
  (4) style or medium adjustments,
  (5) specific feature modifications (expressions, clothing, etc.),
  (6) background changes.
  Use positive, descriptive language and specify what should be included in the edited result.`;

/**
 * Replaces unwanted characters from the input string
 * @param {string} inputString - The input string to process
 * @returns {string} - The processed string
 */
function replaceUnwantedChars(inputString) {
  return inputString
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/"/g, '')
    .trim();
}

/**
 * GoogleImageEdit - A tool for editing images using Google's Imagen API.
 * This tool allows for editing existing images with text prompts, leveraging Google's advanced image editing capabilities.
 */
class GoogleImageEdit extends Tool {
  // Pricing constants in USD per edit
  static PRICING = {
    IMAGEN_3_0_EDIT: -0.04, // imagen-3.0-edit-001
  };

  constructor(fields = {}) {
    super();

    /** @type {boolean} Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;

    this.userId = fields.userId;
    this.fileStrategy = fields.fileStrategy;

    /** @type {boolean} **/
    this.isAgent = fields.isAgent;
    this.returnMetadata = fields.returnMetadata ?? false;

    /** @type {ServerRequest} */
    this.req = fields.req;
    /** @type {MongoFile[]} */
    this.imageFiles = fields.imageFiles ?? [];
    
    if (fields.processFileURL) {
      /** @type {processFileURL} Necessary for output to contain all image metadata. */
      this.processFileURL = fields.processFileURL.bind(this);
    }
    
    if (fields.uploadImageBuffer) {
      /** @type {Function} Upload an image buffer */
      this.uploadImageBuffer = fields.uploadImageBuffer.bind(this);
    }

    this.apiKey = fields.GOOGLE_IMAGEN_API_KEY || this.getApiKey();

    this.name = 'google_image_edit';
    this.description =
      'Use Google Imagen to edit and transform existing images with text prompts. This tool supports image-to-image editing capabilities, allowing you to modify, enhance, or transform images using reference images and descriptive prompts.';

    this.description_for_model = `// Transform existing images based on detailed text prompts. Follow these guidelines:
      // 1. ALWAYS provide specific, detailed editing instructions (3-6 sentences) focusing on:
      //    - What elements to add, remove, or modify
      //    - Style changes (e.g., "convert to watercolor style", "make more vibrant")
      //    - Composition adjustments (e.g., "extend the background", "center the subject")
      //    - Lighting and mood alterations
      // 2. MUST reference existing image(s) by their ID in the image_ids array
      // 3. Optionally provide mask_prompt to focus edits on specific areas (e.g., "the sky", "the person's face")
      
      // Best practices:
      // - Be precise about what changes you want to make
      // - Use moderate strength values (0.5-0.8) for balanced transformations
      // - Use imagen-3.0-edit-001 model for best editing results`;

    // Add base URL from environment variable with fallback
    this.baseUrl = process.env.GOOGLE_IMAGEN_API_URL || 'https://generativelanguage.googleapis.com/v1';

    // Define the schema for structured input
    this.schema = z.object({
      prompt: z
        .string()
        .max(32000)
        .describe(DEFAULT_PROMPT_DESCRIPTION),
      image_ids: z
        .array(z.string())
        .describe(
          `IDs of previously generated or uploaded images to use as reference for editing. 
          Required for image editing. Include as many image IDs as needed for the edit context.
          Never invent or hallucinate IDs; only use IDs that are visible in the conversation.`
        ),
      mask_prompt: z
        .string()
        .optional()
        .describe('Text description of which area to modify. The model will generate a mask based on this description.'),
      model: z
        .enum([
          'imagen-3.0'
        ])
        .optional()
        .default('imagen-3.0')
        .describe('The model to use for editing. Currently only "imagen-3.0" is supported.'),
      safety_filter_level: z
        .enum(['block_low_and_above', 'block_medium_and_above', 'block_only_high'])
        .optional()
        .default('block_medium_and_above')
        .describe(
          'Safety filter level. Options: "block_low_and_above" (highest safety), "block_medium_and_above", "block_only_high" (lowest safety).',
        ),
      quality: z
        .enum(['auto', 'standard', 'premium'])
        .optional()
        .default('auto')
        .describe('The quality of the image. One of auto (default), standard, or premium.'),
      strength: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.8)
        .describe('How much to transform the reference image. Values range from 0 (minimal change) to 1 (maximum change). Default is 0.8.'),
    });
  }

  getAxiosConfig() {
    const config = {};
    if (process.env.PROXY) {
      config.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }
    config.timeout = Number(process.env.GOOGLE_IMAGE_TIMEOUT_MS) || 60000;
    return config;
  }

  /** @param {Object|string} value */
  getDetails(value) {
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value, null, 2);
  }

  getApiKey() {
    const apiKey = process.env.GOOGLE_IMAGEN_API_KEY || '';
    if (!apiKey && !this.override) {
      throw new Error('Missing GOOGLE_IMAGEN_API_KEY environment variable.');
    }
    return apiKey;
  }

  wrapInMarkdown(imageUrl) {
    const serverDomain = process.env.DOMAIN_SERVER || 'http://localhost:3080';
    return `![generated image](${serverDomain}${imageUrl})`;
  }

  returnValue(value) {
    if (typeof value === 'string') {
      return [value, {}];
    } else if (typeof value === 'object') {
      if (Array.isArray(value)) {
        return value;
      }
      return [displayMessage, value];
    }
    return value;
  }

  async _call(data) {
    const { 
      prompt, 
      image_ids,
      mask_prompt,
      model: requestedModel = 'imagen-3.0',
      safety_filter_level = 'block_medium_and_above',
      quality = 'auto',
      strength = 0.8
    } = data;

    // Use provided API key for this request if available, otherwise use default
    const requestApiKey = this.apiKey || this.getApiKey();

    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }
    
    // Validate image_ids
    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      throw new Error('Missing required field: image_ids for image editing');
    }
      
    // Normalize deprecated ids
    const model = requestedModel.startsWith('imagen-3.0') ? 'imagen-3.0' : requestedModel;

    let response;
    try {
      // Image to Image editing
      if (!this.req) {
        throw new Error('Request context required for image editing');
      }
      
      // Get the reference images
      const referenceImages = await this.getImagesFromIds(image_ids);
      if (referenceImages.length === 0) {
        throw new Error(`No valid images found for the provided image_ids: ${image_ids.join(', ')}`);
      }
      
      // Perform image editing
      response = await this.editWithGeminiAPI(
        requestApiKey, 
        replaceUnwantedChars(prompt), 
        referenceImages,
        mask_prompt,
        model,
        safety_filter_level,
        strength,
        quality
      );
    } catch (error) {
      const message = `[GoogleImageEdit] Problem editing the image:`;
      logAxiosError({ error, message });
      return this.returnValue(`Something went wrong when trying to edit the image. The Google Imagen API may be unavailable:
      Error Message: ${error.message}`);
    }

    if (!response) {
      return this.returnValue(`Something went wrong when trying to edit the image. The Google Imagen API may be unavailable`);
    }

    // Retrieve the URLs of generated images and base64 data
    const { imageUrls, base64Data } = this.extractImageData(response, model);
    
    if ((!imageUrls || imageUrls.length === 0) && (!base64Data || base64Data.length === 0)) {
      logger.error('[GoogleImageEdit] No image data received from API. Response:', response);
      return this.returnValue('No image data received from Google Imagen API.');
    }

    const resultCount = Math.max(base64Data?.length || 0, imageUrls?.length || 0);
    const file_ids = Array.from({ length: resultCount }, () => uuidv4());
    const outputFormat = EImageOutputType.PNG;

    const content = [];
    for (let i = 0; i < resultCount; i++) {
      const inlineBase64 = base64Data[i];
      const url = imageUrls[i];

      if (inlineBase64) {
        content.push({
          type: ContentTypes.IMAGE_URL,
          image_url: { url: `data:image/${outputFormat};base64,${inlineBase64}` },
        });
      } else if (url) {
        try {
          const fetchOptions = {};
          if (process.env.PROXY) {
            fetchOptions.agent = new HttpsProxyAgent(process.env.PROXY);
          }
          // eslint-disable-next-line no-undef
          const imgResp = await fetch(url, fetchOptions);
          const arrBuf = await imgResp.arrayBuffer();
          const b64 = Buffer.from(arrBuf).toString('base64');
          content.push({
            type: ContentTypes.IMAGE_URL,
            image_url: { url: `data:image/${outputFormat};base64,${b64}` },
          });

          if (this.processFileURL) {
            const imageName = `img-${file_ids[i]}.png`;
            await this.processFileURL({
              fileStrategy: this.fileStrategy,
              userId: this.userId,
              URL: url,
              fileName: imageName,
              basePath: 'images',
              context: FileContext.image_generation,
            });
          }
        } catch (err) {
          logger.warn('[GoogleImageEdit] Unable to fetch & cache image', err);
        }
      }
    }

    if (!content.length) {
      return this.returnValue('No valid image data received from Google Imagen API.');
    }

    const textResp = [
      {
        type: ContentTypes.TEXT,
        text: `${displayMessage}\n\ngenerated_image_ids: ["${file_ids.join('", "')}"]\nreferenced_image_ids: ["${image_ids.join('", "')}"]`,
      },
    ];

    return [textResp, { content, file_ids }];
  }

  /**
   * Get images from a list of image IDs
   * @param {string[]} image_ids Array of image IDs to retrieve
   * @returns {Promise<Array<{file_id: string, buffer: Buffer, type: string, filename: string}>>} Array of image objects
   */
  async getImagesFromIds(image_ids) {
    if (!this.req || !image_ids || image_ids.length === 0) {
      return [];
    }
    
    // First, try to find images in the current request
    const requestFilesMap = Object.fromEntries(
      (this.imageFiles || []).map((f) => [f.file_id, { ...f }])
    );
    
    // Use getFiles function to get any previously stored files
    const { getFiles } = require('~/models/File');
    
    const idsToFetch = [];
    const foundImages = [];
    
    // Check which images are in the current request
    for (const id of image_ids) {
      const file = requestFilesMap[id];
      if (file) {
        foundImages.push(file);
      } else {
        idsToFetch.push(id);
      }
    }
    
    // Fetch any remaining images from storage
    if (idsToFetch.length > 0) {
      try {
        const fetchedFiles = await getFiles(
          {
            user: this.req.user.id,
            file_id: { $in: idsToFetch },
            height: { $exists: true },
            width: { $exists: true },
          },
          {},
          {},
        );
        
        foundImages.push(...fetchedFiles);
      } catch (error) {
        logger.error('[GoogleImageEdit] Error fetching image files:', error);
      }
    }
    
    // Process the found images to get buffers
    const processedImages = [];
    for (const image of foundImages) {
      try {
        const { getStrategyFunctions } = require('~/server/services/Files/strategies');
        const { getDownloadStream } = getStrategyFunctions(image.source || this.fileStrategy);
        
        if (!getDownloadStream) {
          continue;
        }
        
        const stream = await getDownloadStream(this.req, image.filepath);
        
        if (!stream) {
          continue;
        }
        
        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        
        const buffer = Buffer.concat(chunks);
        processedImages.push({
          file_id: image.file_id,
          buffer,
          type: image.type,
          filename: image.filename
        });
      } catch (error) {
        logger.error(`[GoogleImageEdit] Error processing image ${image.file_id}:`, error);
      }
    }
    
    return processedImages;
  }
  
  /**
   * Edit image using Google Gemini API
   * @param {string} apiKey - The API key
   * @param {string} prompt - The text prompt
   * @param {Array} referenceImages - Reference images for editing
   * @param {string} maskPrompt - Prompt for area to modify (text-based mask generation)
   * @param {string} model - Model to use
   * @param {string} safety_filter_level - Safety filter level
   * @param {number} strength - How much to transform the image (0-1)
   * @param {string} quality - Image quality setting
   * @returns {Promise<Object>} Response from the API
   */
  async editWithGeminiAPI(
    apiKey,
    prompt,
    referenceImages,
    maskPrompt,
    model = 'imagen-3.0',
    safety_filter_level = 'block_medium_and_above',
    strength = 0.8,
    quality = 'auto'
  ) {
    // Google Imagen API edit endpoint
    const editUrl = model.includes('gemini')
      ? `${this.baseUrl}/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:editImage`;
    
    // For Imagen models
    const payload = await this.createImagenEditPayload(
      prompt, 
      referenceImages, 
      maskPrompt,
      safety_filter_level, 
      strength,
      quality
    );
    
    logger.debug('[GoogleImageEdit] Editing image with payload:', payload);
    logger.debug('[GoogleImageEdit] Using endpoint:', editUrl);
    
    const response = await axios.post(editUrl, payload, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      ...this.getAxiosConfig(),
    });
    
    return response.data;
  }
  
  
  /**
   * Create payload for Imagen image editing API
   */
  async createImagenEditPayload(
    prompt,
    referenceImages,
    maskPrompt,
    safety_filter_level,
    strength = 0.8,
    quality = 'auto'
  ) {
    const referenceImage = referenceImages[0];
    const base64Image = referenceImage.buffer.toString('base64');

    const payload = {
      prompt,
      image: base64Image,
      mask_prompt: maskPrompt || undefined,
      strength, // per latest docs the field is `strength`
      safety_filter_level,
    };

    if (quality !== 'auto') {
      payload.quality = quality;
    }

    return payload;
  }
  

  /**
   * Extract image data from the API response
   * @param {Object} response - The API response
   * @param {string} model - The model used
   * @returns {{imageUrls: Array<string>, base64Data: Array<string>}} Object containing arrays of image URLs and base64 data
   */
  extractImageData(response, model) {
    const result = { imageUrls: [], base64Data: [] };
    
    // Extract from Imagen API response structure
    try {
      if (response.images && Array.isArray(response.images)) {
        for (const image of response.images) {
          if (image.url) {
            result.imageUrls.push(image.url);
          }
          if (image.base64) {
            result.base64Data.push(image.base64);
          }
        }
      }
    } catch (error) {
      logger.error('Error extracting image data from Imagen response:', error);
    }
    
    return result;
  }
}

module.exports = GoogleImageEdit;