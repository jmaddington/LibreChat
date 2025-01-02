// FluxAPI.js

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { logger } = require('~/config');
const { FileContext } = require('librechat-data-provider');
const { processFileURL } = require('~/server/services/Files/process');

class FluxAPI extends Tool {
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
      "Use Flux to generate images from text descriptions. This tool is exclusively for visual content.";

    // Aligned description_for_model with DALLE3 plugin
    this.description_for_model = `// Whenever a description of an image is given, generate prompts (following these rules), and use Flux to create the image.
    // Unless the user tells you not to, clean up their prompt and make it better before sending it to Flux.

    // All prompts sent to Flux must abide by the following guidelines:
      // 1. Prompts must be in English. Translate to English if needed.
      // 2. One image per function call. Create only one image per request unless explicitly told to generate more than one image.
      // 3. Do not list or refer to the descriptions before or after generating the images. You do not need to ask for permission to generate; just do it!
      // 4. Visually describe the moods, details, structures, styles, and proportions of the image.
      // 5. Craft your input by "showing" and not "telling" the imagery.
      // 6. Generate images only once per human query unless explicitly requested by the user.
      // 7. The prompt must intricately describe every part of the image in concrete, objective detail. THINK about what the end goal of the description is, and extrapolate that to what would make satisfying images.
      // 8. When returning the image to the user, ensure the image is embedded in your response so the user can see it.
      // 9. Do not include any additional text or descriptions around the image; just provide the image directly.
      // 10. Do not mention or list download links, as they are available in the UI already.
      // 11. Do not repeat the prompt or provide any captions or alt text.
      // 12. Do not add any other commentary or explanations about the image.
      
      // 13. If more than one image is generated, embed each image separately in the response.
      // - Default to the endpoint /v1/flux-pro-1.1 unless the user says otherwise.
      // - Upsample if the user says so.
      // - **Include the generated image(s) in your text response to the user by embedding the Markdown links.**
      // - **Include the prompt you created for flux in your response so the user can see what you generated.**
      
      /* Available endpoints:
       - /v1/flux-pro-1.1
       - /v1/flux-pro
       - /v1/flux-dev
       - /v1/flux-pro-1.1-ultra
      */
    `;

    // Define the schema for structured input
    this.schema = z.object({
      prompt: z.string().describe('Text prompt for image generation.'),
      width: z
        .number()
        .optional()
        .describe(
          'Width of the generated image in pixels. Must be a multiple of 32. Default is 1024.'
        ),
      height: z
        .number()
        .optional()
        .describe(
          'Height of the generated image in pixels. Must be a multiple of 32. Default is 768.'
        ),
      prompt_upsampling: z
        .boolean()
        .optional()
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
        .describe(
          'Tolerance level for input and output moderation. Between 0 and 6, 0 being most strict, 6 being least strict.'
        ),
      // output_format: z
      //   .string()
      //   .optional()
      //   .describe('Output format for the generated image. Can be "jpeg" or "png".'),
      endpoint: z
        .string()
        .optional()
        .describe('Endpoint to use for image generation. Default is /v1/flux-pro.'),
      number_of_images: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe('Number of images to generate, up to a maximum of 24. Default is 1.'),
      raw: z
        .boolean()
        .optional()
        .describe(
          'Generate less processed, more natural-looking images. Only works for /v1/flux-pro-1.1-ultra.'
        ),
    });
  }

  getApiKey() {
    const apiKey = process.env.FLUX_API_KEY || '';
    if (!apiKey && !this.override) {
      throw new Error('Missing FLUX_API_KEY environment variable.');
    }
    return apiKey;
  }

  wrapInMarkdown(imageUrl) {
    return `![generated image](${imageUrl})`;
  }


  returnValue(value) {
    if (this.isAgent === true && typeof value === 'string') {
      return [value, {}];
    } else if (this.isAgent === true && typeof value === 'object') {
      return [
        'DALL-E displayed an image. All generated images are already plainly visible, so don\'t repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.',
        value,
      ];
    }
  }

  async _call(data) {
    const baseUrl = 'https://api.bfl.ml';
    const {
      prompt,
      width = 1024,
      height = 768,
      steps = 40,
      prompt_upsampling = false,
      seed = null,
      safety_tolerance = 6,
      output_format = 'png',
      endpoint = '/v1/flux-pro',
      number_of_images = 1,
      raw = false,
    } = data;

    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }

    const generateUrl = `${baseUrl}${endpoint}`;
    const resultUrl = `${baseUrl}/v1/get_result`;

    const payload = {
      prompt,
      width,
      height,
      steps,
      prompt_upsampling,
      seed,
      safety_tolerance,
      output_format,
      raw,
    };

    logger.debug('[FluxAPI] Generating image with prompt:', prompt);
    logger.debug('[FluxAPI] Using endpoint:', endpoint);
    logger.debug('[FluxAPI] Steps:', steps);
    logger.debug('[FluxAPI] Number of images:', number_of_images);
    logger.debug('[FluxAPI] Safety Tolerance:', safety_tolerance);
    logger.debug('[FluxAPI] Dimensions:', width, 'x', height);

    const headers = {
      'x-key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const totalImages = Math.min(Math.max(number_of_images, 1), 24);

    let imagesMarkdown = '';

    for (let i = 0; i < totalImages; i++) {
      let taskResponse;
      try {
        taskResponse = await axios.post(generateUrl, payload, { headers });
      } catch (error) {
        const details = error?.response?.data || error.message;
        logger.error('[FluxAPI] Error while submitting task:', details);
        return this.returnValue(
          `Something went wrong when trying to generate the image. The Flux API may be unavailable:
          Error Message: ${details}`
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
            headers,
            params: { id: taskId },
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
          const details = error?.response?.data || error.message;
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

        // Always append the image markdown link
        imagesMarkdown += `${this.wrapInMarkdown(result.filepath)}\n`;
      } catch (error) {
        const details = error?.message ?? 'No additional error details.';
        logger.error('Error while saving the image:', details);
        return this.returnValue(`Failed to save the image locally. ${details}`);
      }
    } // End of for-loop

    this.result = imagesMarkdown.trim();
    return this.returnValue(this.result);
  }
}

module.exports = FluxAPI;