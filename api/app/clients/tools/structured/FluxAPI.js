const { z } = require('zod');
const axios = require('axios');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { FileContext, ContentTypes } = require('librechat-data-provider');
const { logger } = require('~/config');
const fs = require('fs');
const yaml = require('js-yaml');

const displayMessage =
  'Flux displayed an image. All generated images are already plainly visible, so don\'t repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.';

/**
 * FluxAPI - A tool for generating high-quality images from text prompts using the Flux API.
 * Each call generates one image. If multiple images are needed, make multiple consecutive calls with the same or varied prompts.
 */
class FluxAPI extends Tool {
  // Pricing constants in USD per image
  static PRICING = {
    FLUX_PRO_1_1_ULTRA: -0.06, // /v1/flux-pro-1.1-ultra
    FLUX_PRO_1_1: -0.04, // /v1/flux-pro-1.1
    FLUX_PRO: -0.05, // /v1/flux-pro
    FLUX_DEV: -0.025, // /v1/flux-dev
    FLUX_PRO_FINETUNED: -0.06, // /v1/flux-pro-finetuned
    FLUX_PRO_1_1_ULTRA_FINETUNED: -0.07, // /v1/flux-pro-1.1-ultra-finetuned
  };

  constructor(fields = {}) {
    super();

    /** @type {boolean} Used to initialize the Tool without necessary variables. */
    this.override = fields.override ?? false;

    this.userId = fields.userId;
    this.fileStrategy = fields.fileStrategy;

    /** @type {boolean} **/
    this.isAgent = fields.isAgent;

    if (fields.processFileURL) {
      /** @type {processFileURL} Necessary for output to contain all image metadata. */
      this.processFileURL = fields.processFileURL.bind(this);
    }

    this.apiKey = fields.FLUX_API_KEY || this.getApiKey();

    this.name = 'flux';
    this.description =
      'Use Flux to generate images from text descriptions. This tool is exclusively for visual content.';

    // Try to load description from yaml file
    let yamlDescription;
    const yamlPaths = ['/app/fluxapi.yaml', '/workspaces/fluxapi.yaml'];

    for (const path of yamlPaths) {
      try {
        if (fs.existsSync(path)) {
          logger.debug(`[FluxAPI] Loading FluxAPI config from ${path}`);
          const fileContents = fs.readFileSync(path, 'utf8');
          const data = yaml.load(fileContents);
          if (data && data.description_for_model) {
            yamlDescription = data.description_for_model;
            break;
          }
        }
      } catch (err) {
        logger.debug(`[FluxAPI] Failed to load FluxAPI config from ${path}: ${err.message}`);
      }
    }

    if (!yamlDescription) {
      this.description_for_model = `
      // Use Flux to generate images from detailed text descriptions. Follow these guidelines:

      1. Craft prompts in natural language, as if explaining to a human artist.
      2. Be precise, detailed, and direct in your descriptions.
      3. Structure your prompt to include:
        - Subject: The main focus of the image
        - Style: Artistic approach or visual aesthetic
        - Composition: Arrangement of elements (foreground, middle ground, background)
        - Lighting: Type and quality of light
        - Color Palette: Dominant colors or scheme
        - Mood/Atmosphere: Emotional tone or ambiance
        - Technical Details: For photorealistic images, include camera settings, lens type, etc.
        - Additional Elements: Supporting details or background information

      4. Leverage Flux's advanced capabilities:
        - Layered Images: Clearly describe elements in different layers of the image
        - Contrasting Elements: Experiment with contrasting colors, styles, or concepts
        - Transparent Materials: Describe see-through elements and their interactions
        - Text Rendering: Utilize Flux's superior text integration abilities
        - Creative Techniques: Consider style fusion, temporal narratives, or emotional gradients

      5. For each human query, generate only one image unless explicitly requested otherwise.
      6. Embed the generated image in your response without additional text or descriptions.
      7. Do not mention download links or repeat the prompt.

      8. Avoid common pitfalls:
        - Don't overload the prompt with too many conflicting ideas
        - Always guide the overall composition, not just individual elements
        - Pay attention to lighting and atmosphere for mood and realism
        - Avoid being too vague; provide specific details
        - Always specify the desired artistic style to avoid defaulting to realism

      Remember to balance specificity with creative freedom, allowing Flux to interpret and surprise you within the boundaries of your description.
      `;
    } else {
      this.description_for_model = yamlDescription;
    }
    // Add base URL from environment variable with fallback
    this.baseUrl = process.env.FLUX_API_BASE_URL || 'https://api.us1.bfl.ai';

    logger.debug('[FluxAPI] Description:', this.description_for_model);

    // Define the schema for structured input
    this.schema = z.object({
      action: z
        .enum(['generate', 'list_finetunes', 'generate_finetuned'])
        .default('generate')
        .describe(
          'Action to perform: "generate" for image generation, "generate_finetuned" for finetuned model generation, "list_finetunes" to get available custom models',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Text prompt for image generation. Required when action is "generate". Not used for list_finetunes.',
        ),
      width: z
        .number()
        .optional()
        .describe(
          'Width of the generated image in pixels. Must be a multiple of 32. Default is 1024.',
        ),
      height: z
        .number()
        .optional()
        .describe(
          'Height of the generated image in pixels. Must be a multiple of 32. Default is 768.',
        ),
      prompt_upsampling: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether to perform upsampling on the prompt.'),
      steps: z
        .number()
        .int()
        .optional()
        .describe('Number of steps to run the model for, a number from 1 to 50. Default is 40.'),
      seed: z.number().optional().describe('Optional seed for reproducibility.'),
      safety_tolerance: z
        .number()
        .optional()
        .default(6)
        .describe(
          'Tolerance level for input and output moderation. Between 0 and 6, 0 being most strict, 6 being least strict.',
        ),
      endpoint: z
        .enum([
          '/v1/flux-pro-1.1',
          '/v1/flux-pro',
          '/v1/flux-dev',
          '/v1/flux-pro-1.1-ultra',
          '/v1/flux-pro-finetuned',
          '/v1/flux-pro-1.1-ultra-finetuned',
        ])
        .optional()
        .default('/v1/flux-pro-1.1')
        .describe('Endpoint to use for image generation.'),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Generate less processed, more natural-looking images. Only works for /v1/flux-pro-1.1-ultra.',
        ),
      finetune_id: z.string().optional().describe('ID of the finetuned model to use'),
      finetune_strength: z
        .number()
        .optional()
        .default(1.1)
        .describe('Strength of the finetuning effect (typically between 0.1 and 1.2)'),
      guidance: z.number().optional().default(2.5).describe('Guidance scale for finetuned models'),
      aspect_ratio: z
        .string()
        .optional()
        .default('16:9')
        .describe('Aspect ratio for ultra models (e.g., "16:9")'),
      number_of_images: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe('Number of images to generate, up to a maximum of 24. Default is 1.'),
    });
  }

  getAxiosConfig() {
    const config = {};
    if (process.env.PROXY) {
      config.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }
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
    const apiKey = process.env.FLUX_API_KEY || '';
    if (!apiKey && !this.override) {
      throw new Error('Missing FLUX_API_KEY environment variable.');
    }
    return apiKey;
  }

  wrapInMarkdown(imageUrl) {
    const serverDomain = process.env.DOMAIN_SERVER || 'http://localhost:3080';
    return `![generated image](${serverDomain}${imageUrl})`;
  }

  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      return [
        displayMessage,
        value,
      ];
    }
  }

  async _call(data) {
    const { action = 'generate', ...imageData } = data;

    // Use provided API key for this request if available, otherwise use default
    const requestApiKey = this.apiKey || this.getApiKey();

    // Handle list_finetunes action
    if (action === 'list_finetunes') {
      return this.getMyFinetunes(requestApiKey);
    }

    // Handle finetuned generation
    if (action === 'generate_finetuned') {
      return this.generateFinetunedImage(imageData, requestApiKey);
    }

    // For generate action, ensure prompt is provided
    if (!imageData.prompt) {
      throw new Error('Missing required field: prompt');
    }

    let payload = {
      prompt: imageData.prompt,
      prompt_upsampling: imageData.prompt_upsampling || false,
      safety_tolerance: imageData.safety_tolerance || 6,
      output_format: imageData.output_format || 'png',
      width: imageData.width || 1024,
      height: imageData.height || 768,
      steps: imageData.steps || 40,
      seed: imageData.seed || null,
      number_of_images: imageData.number_of_images || 1,
      raw: imageData.raw || false,
    };

    const generateUrl = `${this.baseUrl}${imageData.endpoint || '/v1/flux-pro'}`;
    const resultUrl = `${this.baseUrl}/v1/get_result`;

    logger.debug('[FluxAPI] Generating image with prompt:', prompt);
    logger.debug('[FluxAPI] Using endpoint:', generateUrl);
    logger.debug('[FluxAPI] Steps:', payload.steps);
    logger.debug('[FluxAPI] Number of images:', c);
    logger.debug('[FluxAPI] Safety Tolerance:', payload.safety_tolerance);
    logger.debug('[FluxAPI] Dimensions:', payload.width, 'x', payload.height);

    const totalImages = Math.min(Math.max(payload.number_of_images, 1), 24);

    let imagesMarkdown = '';
    let imagesMetadata = [];

    for (let i = 0; i < totalImages; i++) {
      let taskResponse;
      try {
        taskResponse = await axios.post(generateUrl, payload, {
          headers: {
            'x-key': requestApiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          ...this.getAxiosConfig(),
        });
      } catch (error) {
        const details = this.getDetails(error?.response?.data || error.message);
        logger.error('[FluxAPI] Error while submitting task:', details);

        return this.returnValue(
          `Something went wrong when trying to generate the image. The Flux API may be unavailable:
        Error Message: ${details}`,
        );
      }

      const taskId = taskResponse.data.id;

      // Polling for the result
      let status = 'Pending';
      let resultData = null;
      while (status !== 'Ready' && status !== 'Error') {
        try {
          // Wait 2 seconds between polls
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const resultResponse = await axios.get(resultUrl, {
            headers: {
              'x-key': requestApiKey,
              Accept: 'application/json',
            },
            params: { id: taskId },
            ...this.getAxiosConfig(),
          });
          status = resultResponse.data.status;

          if (status === 'Ready') {
            resultData = resultResponse.data.result;
            break;
          } else if (status === 'Error') {
            logger.error('[FluxAPI] Error in task:', resultResponse.data);
            return this.returnValue('An error occurred during image generation.');
          }
        } catch (error) {
          const details = this.getDetails(error?.response?.data || error.message);
          logger.error('[FluxAPI] Error while getting result:', details);
          return this.returnValue('An error occurred while retrieving the image.');
        }
      }

      // If the status was 'Error', we skip the rest
      if (status === 'Error') {
        continue;
      }

      // If no result data
      if (!resultData || !resultData.sample) {
        logger.error('[FluxAPI] No image data received from API. Response:', resultData);
        return this.returnValue('No image data received from Flux API.');
      }

      // Try saving the image locally
      const imageUrl = resultData.sample;
      const imageName = `img-${uuidv4()}.png`;

      if (this.isAgent) {
        try {
          // Fetch the image and convert to base64
          const fetchOptions = {};
          if (process.env.PROXY) {
            fetchOptions.agent = new HttpsProxyAgent(process.env.PROXY);
          }
          const imageResponse = await fetch(imageUrl, fetchOptions);
          const arrayBuffer = await imageResponse.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          const content = [
            {
              type: ContentTypes.IMAGE_URL,
              image_url: {
                url: `data:image/png;base64,${base64}`,
              },
            },
          ];

          const response = [
            {
              type: ContentTypes.TEXT,
              text: displayMessage,
            },
          ];
          return [response, { content }];
        } catch (error) {
          logger.error('Error processing image for agent:', error);
          return this.returnValue(`Failed to process the image. ${error.message}`);
        }
      }

      try {
        logger.debug('[FluxAPI] Saving image:', imageUrl);
        const result = await this.processFileURL({
          fileStrategy: this.fileStrategy,
          userId: this.userId,
          URL: imageUrl,
          fileName: imageName,
          basePath: 'images',
          context: FileContext.image_generation,
        });

        logger.debug('[FluxAPI] Image saved to path:', result.filepath);

        // Calculate cost based on endpoint
        /**
         * TODO: Cost handling
         const endpoint = imageData.endpoint || '/v1/flux-pro';
         const endpointKey = Object.entries(FluxAPI.PRICING).find(([key, _]) =>
         endpoint.includes(key.toLowerCase().replace(/_/g, '-')),
         )?.[0];
         const cost = FluxAPI.PRICING[endpointKey] || 0;
         */
        // this.result = this.returnMetadata ? result : this.wrapInMarkdown(result.filepath);
        // return this.returnValue(this.result);
        // Always append the image markdown link
        if (this.returnMetadata) {
          imagesMetadata.push(result);
        }
        imagesMarkdown += `${this.wrapInMarkdown(result.filepath)}\n`;
      } catch (error) {
        const details = this.getDetails(error?.message ?? 'No additional error details.');
        logger.error('Error while saving the image:', details);
        return this.returnValue(`Failed to save the image locally. ${details}`);
      }
    }

    this.result = {
      'Markdown Embeds for User': imagesMarkdown.trim().split('\n'),
    };
    if (this.returnMetadata) {
      this.result['returnMetadata'] = imagesMetadata;
    }
    return this.returnValue(this.result);
  }

  async getMyFinetunes(apiKey = null) {
    const finetunesUrl = `${this.baseUrl}/v1/my_finetunes`;
    const detailsUrl = `${this.baseUrl}/v1/finetune_details`;

    try {
      const headers = {
        'x-key': apiKey || this.getApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Get list of finetunes
      const response = await axios.get(finetunesUrl, {
        headers,
        ...this.getAxiosConfig(),
      });
      const finetunes = response.data.finetunes;

      // Fetch details for each finetune
      const finetuneDetails = await Promise.all(
        finetunes.map(async (finetuneId) => {
          try {
            const detailResponse = await axios.get(`${detailsUrl}?finetune_id=${finetuneId}`, {
              headers,
              ...this.getAxiosConfig(),
            });
            return {
              id: finetuneId,
              ...detailResponse.data,
            };
          } catch (error) {
            logger.error(`[FluxAPI] Error fetching details for finetune ${finetuneId}:`, error);
            return {
              id: finetuneId,
              error: 'Failed to fetch details',
            };
          }
        }),
      );

      if (this.isAgent) {
        const formattedDetails = JSON.stringify(finetuneDetails, null, 2);
        return [`Here are the available finetunes:\n${formattedDetails}`, null];
      }
      return JSON.stringify(finetuneDetails);
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while getting finetunes:', details);
      const errorMsg = `Failed to get finetunes: ${details}`;
      return this.isAgent ? this.returnValue([errorMsg, {}]) : new Error(errorMsg);
    }
  }

  async generateFinetunedImage(imageData, requestApiKey) {
    if (!imageData.prompt) {
      throw new Error('Missing required field: prompt');
    }

    if (!imageData.finetune_id) {
      throw new Error(
        'Missing required field: finetune_id for finetuned generation. Please supply a finetune_id!',
      );
    }

    // Validate endpoint is appropriate for finetuned generation
    const validFinetunedEndpoints = ['/v1/flux-pro-finetuned', '/v1/flux-pro-1.1-ultra-finetuned'];
    const endpoint = imageData.endpoint || '/v1/flux-pro-finetuned';

    if (!validFinetunedEndpoints.includes(endpoint)) {
      throw new Error(
        `Invalid endpoint for finetuned generation. Must be one of: ${validFinetunedEndpoints.join(', ')}`,
      );
    }

    let payload = {
      prompt: imageData.prompt,
      prompt_upsampling: imageData.prompt_upsampling || false,
      safety_tolerance: imageData.safety_tolerance || 6,
      output_format: imageData.output_format || 'png',
      finetune_id: imageData.finetune_id,
      finetune_strength: imageData.finetune_strength || 1.0,
      guidance: imageData.guidance || 2.5,
    };

    // Add optional parameters if provided
    if (imageData.width) {
      payload.width = imageData.width;
    }
    if (imageData.height) {
      payload.height = imageData.height;
    }
    if (imageData.steps) {
      payload.steps = imageData.steps;
    }
    if (imageData.seed !== undefined) {
      payload.seed = imageData.seed;
    }
    if (imageData.raw) {
      payload.raw = imageData.raw;
    }

    const generateUrl = `${this.baseUrl}${endpoint}`;
    const resultUrl = `${this.baseUrl}/v1/get_result`;

    logger.debug('[FluxAPI] Generating finetuned image with payload:', payload);
    logger.debug('[FluxAPI] Using endpoint:', generateUrl);

    let taskResponse;
    try {
      taskResponse = await axios.post(generateUrl, payload, {
        headers: {
          'x-key': requestApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...this.getAxiosConfig(),
      });
    } catch (error) {
      const details = this.getDetails(error?.response?.data || error.message);
      logger.error('[FluxAPI] Error while submitting finetuned task:', details);
      return this.returnValue(
        `Something went wrong when trying to generate the finetuned image. The Flux API may be unavailable:
        Error Message: ${details}`,
      );
    }

    const taskId = taskResponse.data.id;

    // Polling for the result
    let status = 'Pending';
    let resultData = null;
    while (status !== 'Ready' && status !== 'Error') {
      try {
        // Wait 2 seconds between polls
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const resultResponse = await axios.get(resultUrl, {
          headers: {
            'x-key': requestApiKey,
            Accept: 'application/json',
          },
          params: { id: taskId },
          ...this.getAxiosConfig(),
        });
        status = resultResponse.data.status;

        if (status === 'Ready') {
          resultData = resultResponse.data.result;
          break;
        } else if (status === 'Error') {
          logger.error('[FluxAPI] Error in finetuned task:', resultResponse.data);
          return this.returnValue('An error occurred during finetuned image generation.');
        }
      } catch (error) {
        const details = this.getDetails(error?.response?.data || error.message);
        logger.error('[FluxAPI] Error while getting finetuned result:', details);
        return this.returnValue('An error occurred while retrieving the finetuned image.');
      }
    }

    // If no result data
    if (!resultData || !resultData.sample) {
      logger.error('[FluxAPI] No image data received from API. Response:', resultData);
      return this.returnValue('No image data received from Flux API.');
    }

    // Try saving the image locally
    const imageUrl = resultData.sample;
    const imageName = `img-${uuidv4()}.png`;

    try {
      logger.debug('[FluxAPI] Saving finetuned image:', imageUrl);
      const result = await this.processFileURL({
        fileStrategy: this.fileStrategy,
        userId: this.userId,
        URL: imageUrl,
        fileName: imageName,
        basePath: 'images',
        context: FileContext.image_generation,
      });

      logger.debug('[FluxAPI] Finetuned image saved to path:', result.filepath);

      // Calculate cost based on endpoint
      const endpointKey = endpoint.includes('ultra')
        ? 'FLUX_PRO_1_1_ULTRA_FINETUNED'
        : 'FLUX_PRO_FINETUNED';
      const cost = FluxAPI.PRICING[endpointKey] || 0;
      // Return the result based on returnMetadata flag
      this.result = this.returnMetadata ? result : this.wrapInMarkdown(result.filepath);
      return this.returnValue(this.result);
    } catch (error) {
      const details = this.getDetails(error?.message ?? 'No additional error details.');
      logger.error('Error while saving the finetuned image:', details);
      return this.returnValue(`Failed to save the finetuned image locally. ${details}`);
    }
  }
}

module.exports = FluxAPI;
