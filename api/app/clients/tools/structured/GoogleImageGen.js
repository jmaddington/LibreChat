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
const DEFAULT_PROMPT_DESCRIPTION = `Describe the image you want in detail. 
  Be highly specific—break your idea into layers: 
  (1) main concept and subject,
  (2) composition and position,
  (3) lighting and mood,
  (4) style, medium, or camera details,
  (5) important features (age, expression, clothing, etc.),
  (6) background.
  Use positive, descriptive language and specify what should be included, not what to avoid. 
  List number and characteristics of people/objects, and mention style/technical requirements (e.g., "detailed 3D render", "professional photograph", "oil painting").`;

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
 * GoogleImageGen - A tool for generating high-quality images from text prompts using Google's Imagen API.
 * Each call generates one image. If multiple images are needed, make multiple consecutive calls with the same or varied prompts.
 */
class GoogleImageGen extends Tool {
  // Pricing constants in USD per image
  static PRICING = {
    IMAGEN_3_0: -0.04, // imagen-3.0-generate-001
    IMAGEN_3_0_002: -0.04, // imagen-3.0-generate-002 
    GEMINI_2_0_FLASH: -0.02, // gemini-2.0-flash-exp with image generation
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
    
    if (fields.processFileURL) {
      /** @type {processFileURL} Necessary for output to contain all image metadata. */
      this.processFileURL = fields.processFileURL.bind(this);
    }
    
    if (fields.uploadImageBuffer) {
      /** @type {Function} Upload an image buffer */
      this.uploadImageBuffer = fields.uploadImageBuffer.bind(this);
    }

    this.apiKey = fields.GOOGLE_IMAGEN_API_KEY || this.getApiKey();

    this.name = 'google_image_gen';
    this.description =
      'Use Google Imagen and Gemini models to generate high-quality images from text descriptions. This tool provides text-to-image generation capabilities with various styles and settings.';

    this.description_for_model = `// Transform any image description into a detailed, high-quality prompt. Never submit a prompt under 3 sentences. Follow these core rules:
      // 1. ALWAYS enhance basic prompts into 5-10 detailed sentences (e.g., "a cat" becomes: "A close-up photo of a sleek Siamese cat with piercing blue eyes. The cat sits elegantly on a vintage leather armchair, its tail curled gracefully around its paws. Warm afternoon sunlight streams through a nearby window, casting gentle shadows across its face and highlighting the subtle variations in its cream and chocolate-point fur. The background is softly blurred, creating a shallow depth of field that draws attention to the cat's expressive features. The overall composition has a peaceful, contemplative mood with a professional photography style.")
      // 2. Each prompt MUST be 3-6 descriptive sentences minimum, focusing on visual elements: lighting, composition, mood, and style
      // Focus on quality artistic details. You can specify styles like "photorealistic", "3D render", "oil painting", "watercolor", "pencil drawing", etc.
      
      // Choose Gemini when:
      // - You need contextually relevant images that leverage world knowledge and reasoning.
      // - Seamlessly blending text and images is important.
      // - You want accurate visuals embedded within long text sequences.
      
      // Choose Imagen 3 when:
      // - Image quality, photorealism, artistic detail, or specific styles (e.g., impressionism, anime) are top priorities.
      // - Infusing branding, style, or generating logos and product designs.`;

    // Add base URL from environment variable with fallback
    this.baseUrl = process.env.GOOGLE_IMAGEN_API_URL || 'https://generativelanguage.googleapis.com/v1';

    // Define the schema for structured input
    this.schema = z.object({
      prompt: z
        .string()
        .max(32000)
        .describe(DEFAULT_PROMPT_DESCRIPTION),
      number_of_images: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .default(1)
        .describe('Number of images to generate (1-4). Default is 1.'),
      aspect_ratio: z
        .enum(['1:1', '3:4', '4:3', '9:16', '16:9'])
        .optional()
        .default('1:1')
        .describe('Aspect ratio of the generated image. Options: "1:1", "3:4", "4:3", "9:16", "16:9". Default is "1:1".'),
      model: z
        .enum([
          'imagen-3.0',
          'imagen-3.0-generate-001',
          'imagen-3.0-generate-002',
          'gemini-2.0-flash-preview-image-generation'
        ])
        .optional()
        .default('imagen-3.0')
        .describe('The model to use. Options: "imagen-3.0" (default) or "gemini-2.0-flash-preview-image-generation".'),
      safety_filter_level: z
        .enum(['block_low_and_above', 'block_medium_and_above', 'block_only_high'])
        .optional()
        .default('block_medium_and_above')
        .describe(
          'Safety filter level. Options: "block_low_and_above" (highest safety), "block_medium_and_above", "block_only_high" (lowest safety).',
        ),
      person_generation: z
        .enum(['allow_adult', 'dont_allow'])
        .optional()
        .default('allow_adult')
        .describe('Control of person or face generation. Options: "allow_adult" (default), "dont_allow".'),
      negative_prompt: z
        .string()
        .optional()
        .describe('Elements to avoid in the generated image. Use this instead of saying "without X" in your prompt.'),
      quality: z
        .enum(['auto', 'standard', 'premium'])
        .optional()
        .default('auto')
        .describe('The quality of the image. One of auto (default), standard, or premium.'),
    });
  }

  getAxiosConfig() {
    const config = {};
    if (process.env.PROXY) {
      config.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }
    // Add a default timeout (60s) unless one is already provided via env
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
      number_of_images = 1, 
      aspect_ratio = '1:1',
      model: requestedModel = 'imagen-3.0',
      safety_filter_level = 'block_medium_and_above',
      person_generation = 'allow_adult',
      negative_prompt = '',
      quality = 'auto'
    } = data;

    // Use provided API key for this request if available, otherwise use default
    const requestApiKey = this.apiKey || this.getApiKey();

    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }
    
    // Normalize deprecated Imagen model ids to current one
    if (requestedModel.startsWith('imagen-3.0-')) {
      requestedModel = 'imagen-3.0';
    }

    let model = requestedModel;

    let response;
    try {
      // Text to Image generation
      response = await this.generateWithGeminiAPI(
        requestApiKey, 
        replaceUnwantedChars(prompt), 
        number_of_images, 
        aspect_ratio,
        model, 
        safety_filter_level,
        person_generation,
        negative_prompt,
        quality
      );
    } catch (error) {
      const message = `[GoogleImageGen] Problem generating the image:`;
      logAxiosError({ error, message });
      return this.returnValue(`Something went wrong when trying to generate the image. The Google Imagen API may be unavailable:
      Error Message: ${error.message}`);
    }

    if (!response) {
      return this.returnValue(`Something went wrong when trying to generate the image. The Google Imagen API may be unavailable`);
    }

    // Retrieve the URLs of generated images and base64 data
    const { imageUrls, base64Data } = this.extractImageData(response, model);
    
    if ((!imageUrls || imageUrls.length === 0) && (!base64Data || base64Data.length === 0)) {
      logger.error('[GoogleImageGen] No image data received from API. Response:', response);
      return this.returnValue('No image data received from Google Imagen API.');
    }

    // Use base64 data if available, otherwise use URL
    const resultCount = Math.max(base64Data?.length || 0, imageUrls?.length || 0);
    const file_ids = Array.from({ length: resultCount }, () => uuidv4());

    const content = [];
    for (let i = 0; i < resultCount; i++) {
      const inlineBase64 = base64Data[i];
      const url = imageUrls[i];
      if (inlineBase64) {
        content.push({
          type: ContentTypes.IMAGE_URL,
          image_url: {
            url: `data:image/${EImageOutputType.PNG};base64,${inlineBase64}`,
          },
        });
      } else if (url) {
        // Convert remote url to base64 for agent consumption
        try {
          const fetchOptions = {};
          if (process.env.PROXY) {
            fetchOptions.agent = new HttpsProxyAgent(process.env.PROXY);
          }
          // eslint-disable-next-line no-undef
          const imageResponse = await fetch(url, fetchOptions);
          const arrayBuffer = await imageResponse.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          content.push({
            type: ContentTypes.IMAGE_URL,
            image_url: {
              url: `data:image/${EImageOutputType.PNG};base64,${base64}`,
            },
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
          logger.warn('[GoogleImageGen] Failed to fetch & cache image', err);
        }
      }
    }

    if (!content.length) {
      return this.returnValue('No valid image data received from Google Imagen API.');
    }

    const textResponse = [
      {
        type: ContentTypes.TEXT,
        text: `${displayMessage}\n\ngenerated_image_ids: ["${file_ids.join('", "')}"]`,
      },
    ];

    return [textResponse, { content, file_ids }];
  }

  /**
   * Generate image using Google Gemini API
   * @param {string} apiKey - The API key
   * @param {string} prompt - The text prompt
   * @param {number} number_of_images - Number of images to generate
   * @param {string} aspect_ratio - Aspect ratio of the image
   * @param {string} model - Model to use
   * @param {string} safety_filter_level - Safety filter level
   * @param {string} person_generation - Person generation setting
   * @param {string} negative_prompt - Negative prompt
   * @param {string} quality - Image quality setting
   * @returns {Promise<Object>} Response from the API
   */
  async generateWithGeminiAPI(
    apiKey, 
    prompt, 
    number_of_images, 
    aspect_ratio,
    model,
    safety_filter_level,
    person_generation,
    negative_prompt,
    quality = 'auto'
  ) {
    // Google Gemini API Imagen endpoint
    const generateUrl = model.includes('gemini') 
      ? `${this.baseUrl}/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage`;

    const payload = model.includes('gemini') 
      ? this.createGeminiPayload(prompt, number_of_images, aspect_ratio, negative_prompt, quality)
      : this.createImagenPayload(prompt, number_of_images, aspect_ratio, safety_filter_level, person_generation, negative_prompt, quality);

    logger.debug('[GoogleImageGen] Generating image with payload:', payload);
    logger.debug('[GoogleImageGen] Using endpoint:', generateUrl);

    const response = await axios.post(generateUrl, payload, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      ...this.getAxiosConfig(),
    });

    return response.data;
  }


  /**
   * Create payload for Imagen API
   */
  createImagenPayload(prompt, number_of_images, aspect_ratio, safety_filter_level, person_generation, negative_prompt, quality = 'auto') {
    const payload = {
      prompt: prompt,
      number_of_images: number_of_images,
      aspect_ratio: aspect_ratio,
      safety_filter_level: safety_filter_level,
      person_generation: person_generation
    };

    // Add negative prompt if provided
    if (negative_prompt) {
      payload.negative_prompt = negative_prompt;
    }
    
    // Add quality if not auto
    if (quality !== 'auto') {
      payload.quality = quality;
    }

    return payload;
  }

  /**
   * Create payload for Gemini API with image generation
   */
  createGeminiPayload(prompt, number_of_images, aspect_ratio, negative_prompt, quality = 'auto') {
    // For Gemini, incorporate requested parameters into prompt because the preview model doesn't expose them directly
    let enhancedPrompt = `Generate ${number_of_images} image${number_of_images > 1 ? 's' : ''} with aspect ratio ${aspect_ratio}`;
    // Add quality description to the prompt
    if (quality === 'premium') {
      enhancedPrompt += ' with extremely high quality and detail';
    } else if (quality === 'standard') {
      enhancedPrompt += ' with good quality';
    }

    enhancedPrompt += ` of: ${prompt}`;

    if (negative_prompt) {
      enhancedPrompt += `. Avoid: ${negative_prompt}`;
    }

    const payload = {
      contents: [
        {
          role: 'user', // explicit role field as per latest docs
          parts: [{
            text: enhancedPrompt,
          }],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    };

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
    
    if (model.includes('gemini')) {
      // Extract from Gemini response structure
      try {
        const candidates = response.candidates || [];

        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData && part.inlineData.data) {
              // Store base64 data directly
              result.base64Data.push(part.inlineData.data);
              // Also create a data URL for compatibility
              const mimeType = part.inlineData.mimeType || 'image/png';
              result.imageUrls.push(`data:${mimeType};base64,${part.inlineData.data}`);
            }
          }
        }
      } catch (error) {
        logger.error('Error extracting images from Gemini response:', error);
      }
    } else {
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
    }
    
    return result;
  }
}

module.exports = GoogleImageGen;