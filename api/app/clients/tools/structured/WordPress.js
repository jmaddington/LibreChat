const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');

class WordPress extends Tool {
  name = 'wordpress';
  description =
    'A tool to interact with WordPress. Supports creating, listing, editing, and deleting posts or pages.';

  // Schema for validating input arguments
  schema = z.object({
    action: z
      .enum([
        'createPost',
        'editPost',
        'listCategories',
        'listTags',
        'searchPosts',
        'searchByMeta',
        'updatePostMeta',
        'updateCategory',
        'updateTag',
        'getPostMeta',
        'deletePostMeta',
        'listPaginatedPosts',
        'listPaginatedCategories',
        'listPaginatedTags',
        'getPostContentById',
        'getFeaturedImage',
        'addCategory',
        'deleteCategory',
        'addTag',
        'deleteTag',
        'uploadImageFromURL',
        'setAIImageAsFeatured',
        'updateImageMeta',
        'generateAndUploadAIImage',
      ])
      .describe('The action to perform on WordPress.'),
    postId: z
      .number()
      .optional()
      .describe('The ID of the post to edit or update meta or set featured image.'),
    title: z.string().min(1).optional().describe('The title of the post or page.'),
    content: z.string().min(1).optional().describe('The content of the post or page.'),
    status: z.enum(['draft', 'publish', 'future']).optional().describe('The status of the post.'),
    type: z.enum(['post', 'page']).optional().describe("The type of content. Defaults to 'post'."),
    tags: z.array(z.number()).optional().describe('An array of tag IDs to attach to the post.'),
    categories: z
      .array(z.number())
      .optional()
      .describe('An array of category IDs to attach to the post.'),
    date: z.string().optional().describe('The scheduled date and time in ISO 8601 format.'),
    searchType: z
      .enum(['contains', 'starts_with', 'ends_with'])
      .optional()
      .describe('Search type for title or content.'),
    searchValue: z.string().optional().describe('The value to search for in title or content.'),
    tagId: z.number().optional().describe('The ID of the tag to filter posts.'),
    categoryId: z.number().optional().describe('The ID of the category to filter posts.'),
    metaKey: z.string().optional().describe('The meta key to search or update.'),
    metaValue: z.string().optional().describe('The meta value to search or update.'),
    name: z
      .string()
      .optional()
      .describe('New name for category or tag for updateCategory or updateTag.'),
    description: z
      .string()
      .optional()
      .describe('New description for category or tag for updateCategory or updateTag.'),
    page: z.number().optional().default(1).describe('The page number for pagination.'),
    perPage: z.number().optional().default(20).describe('The number of posts per page.'),

    prompt: z.string().optional().describe('Text description for generating an AI image.'),
    imageUrl: z.string().optional().describe('URL of the image to upload.'),
    width: z.number().optional().describe('Width to resize the image before uploading.'),
    height: z.number().optional().describe('Height to resize the image before uploading.'),
    imageBase64: z
      .string()
      .optional()
      .describe('Base64-encoded image for AI-generated image uploads.'),
    caption: z.string().optional().describe('Caption for the image.'),
    altText: z.string().optional().describe('Alt text for the image.'),
    mediaId: z.number().optional().describe('ID of the media image to update metadata.'),
  });

  constructor(fields = {}) {
    super();

    // WordPress credentials
    this.baseUrl = fields.WORDPRESS_BASE_URL || process.env.WORDPRESS_BASE_URL;
    this.username = fields.WORDPRESS_USERNAME || process.env.WORDPRESS_USERNAME;
    this.password = fields.WORDPRESS_PASSWORD || process.env.WORDPRESS_PASSWORD;

    // Token cache
    this.token = null;
    this.tokenExpiry = null;

    if (!this.baseUrl || !this.username || !this.password) {
      throw new Error('WordPress credentials or base URL are missing.');
    }
  }

  // Authenticate with WordPress and get a token
  async getToken() {
    // Return cached token if still valid (assuming 1-hour validity)
    const now = Date.now();
    if (this.token && this.tokenExpiry && now < this.tokenExpiry) {
      return this.token;
    }

    const response = await fetch(`${this.baseUrl}/wp-json/jwt-auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Authentication failed: ${data.message || 'Unknown error'}`);
    }

    // Cache the token for 50 minutes (assuming 1-hour validity)
    this.token = data.token;
    this.tokenExpiry = now + 50 * 60 * 1000;

    return this.token;
  }

  // Fetch posts from WordPress
  async listPosts(token) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to fetch posts: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async createPost(
    token,
    title,
    content,
    status = 'draft',
    type = 'post',
    tags = [],
    categories = [],
    date = null,
  ) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/${type}s`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title,
        content,
        status,
        tags,
        categories,
        date,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to create ${type}: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async editPost(token, postId, updatedFields) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updatedFields),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to edit post: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async deletePost(token, postId) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to delete post: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async uploadImageFromURL(token, imageUrl, width = null, height = null, postId = null) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/upload-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ imageUrl, width, height, postId }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to upload image: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async setAIImageAsFeatured(token, postId, imageBase64, title, caption, altText) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/set-ai-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ postId, imageBase64, title, caption, altText }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to set AI image: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async updateImageMeta(token, postId = null, mediaId = null, title, caption, altText) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/update-image-meta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ postId, mediaId, title, caption, altText }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to update image metadata: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async getCategoryIdByName(token, categoryName) {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        `Failed to fetch category ID for name "${categoryName}": ${data.message || 'Unknown error'}`,
      );
    }

    // Return the first matching category's ID or null if no match
    return data.length > 0 ? data[0].id : null;
  }

  async getTagIdByName(token, tagName) {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        `Failed to fetch tag ID for name "${tagName}": ${data.message || 'Unknown error'}`,
      );
    }

    // Return the first matching tag's ID or null if no match
    return data.length > 0 ? data[0].id : null;
  }

  async searchPosts(
    token,
    searchType,
    searchValue,
    tagId,
    tagName,
    categoryId,
    categoryName,
    type = 'post',
  ) {
    const params = new URLSearchParams();

    // Handle searchType and searchValue
    if (searchType && searchValue) {
      if (searchType === 'contains') {
        params.append('search', searchValue);
      } else if (searchType === 'starts_with') {
        params.append('title', `${searchValue}*`);
      } else if (searchType === 'ends_with') {
        params.append('title', `*${searchValue}`);
      }
    }

    // Fetch tag ID if tagName is provided
    if (tagName) {
      tagId = await this.getTagIdByName(token, tagName);
      if (!tagId) {
        throw new Error(`No tag found with name "${tagName}".`);
      }
    }

    if (categoryName) {
      categoryId = await this.getCategoryIdByName(token, categoryName);
      if (!categoryId) {
        throw new Error(`No category found with name "${categoryName}".`);
      }
    }

    params.append('status', 'any');

    if (tagId) {
      params.append('tags', tagId);
    }
    if (categoryId) {
      params.append('categories', categoryId);
    }

    // Query posts or pages
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/${type}s?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to search posts: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async searchByMeta(token, metaKey, metaValue, type = 'post') {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/${type}s?meta_key=${metaKey}&meta_value=${metaValue}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to search by meta: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async updatePostMeta(token, postId, metaKey, metaValue) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/update-meta/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        post_id: postId,
        meta_key: metaKey,
        meta_value: metaValue,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to update post meta: ${data.message || 'Unknown error'}`);
    }
    return data;
  }
  async getPostMeta(token, postId) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to fetch post meta: ${data.message || 'Unknown error'}`);
    }

    // Ensure meta is returned (requires functions.php customization)
    return data.meta
      ? data.meta
      : { error: 'Meta not available. Ensure it is exposed in the REST API.' };
  }

  async deletePostMeta(token, postId, metaKey) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/delete-meta/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        post_id: postId,
        meta_key: metaKey,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to delete post meta: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async listCategories(token) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/categories`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to fetch categories: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async updateCategoryOrTag(token, id, name, description, type = 'categories') {
    const endpoint =
      type === 'categories' ? '/custom/v1/update-category/' : '/custom/v1/update-tag/';

    // Prepare the payload only with provided fields
    const payload = {};
    if (id) {
      payload.id = id;
    }
    if (name) {
      payload.name = name;
    }
    if (description) {
      payload.description = description;
    }

    // Ensure at least one field is provided for update
    if (Object.keys(payload).length < 2) {
      throw new Error(`At least one of name or description is required for updating ${type}.`);
    }

    const response = await fetch(`${this.baseUrl}/wp-json${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (response.ok) {
      return {
        message: `${type === 'categories' ? 'Category' : 'Tag'} updated successfully`,
        id: data.id,
        name: data.name || null,
        description: data.description || null,
      };
    } else {
      throw new Error(`Failed to update ${type}: ${data.message || 'Unknown error'}`);
    }
  }

  async listTags(token) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/tags`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to fetch tags: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async addCategory(token, name, description) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/add-category/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name,
        description,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to add category: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  // Function to delete a category
  async deleteCategory(token, categoryId) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/delete-category/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: categoryId,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to delete category: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  // Function to add a new tag
  async addTag(token, name, description) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/add-tag/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name,
        description,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to add tag: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  // Function to delete a tag
  async deleteTag(token, tagId) {
    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/delete-tag/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: tagId,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to delete tag: ${data.message || 'Unknown error'}`);
    }
    return data;
  }

  async listPaginatedPosts(token, page = 1, perPage = 20) {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/posts?page=${page}&per_page=${perPage}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!response.ok) {
      throw new Error('Failed to fetch paginated posts');
    }

    const data = await response.json();

    // Extract relevant fields, including the post status
    return data.map((post) => ({
      id: post.id,
      title: post.title.rendered,
      status: post.status, // Include post status
    }));
  }

  async listPaginatedCategories(token, page = 1, perPage = 20) {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/categories?page=${page}&per_page=${perPage}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error('Failed to fetch paginated categories');
    }

    const data = await response.json();
    return data;
  }

  async listPaginatedTags(token, page = 1, perPage = 20) {
    const response = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/tags?page=${page}&per_page=${perPage}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error('Failed to fetch paginated tags');
    }

    const data = await response.json();
    return data;
  }

  async getPostContentById(token, postId) {
    const response = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch post content');
    }

    const data = await response.json();
    return data.content.rendered;
  }

  async getFeaturedImage(token, postId) {
    const postResponse = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${postId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!postResponse.ok) {
      throw new Error('Failed to fetch post details');
    }

    const postData = await postResponse.json();

    if (!postData.featured_media) {
      return 'No featured image';
    }

    const mediaResponse = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/media/${postData.featured_media}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!mediaResponse.ok) {
      throw new Error('Failed to fetch featured image details');
    }

    const mediaData = await mediaResponse.json();

    return mediaData.guid && mediaData.guid.rendered
      ? mediaData.guid.rendered
      : 'No featured image available';
  }

  async generateAndUploadAIImage(token, prompt, postId) {
    // Step 1: Generate Image from DALL-E API
    const openaiApiKey =
      process.env.OPENAI_API_KEY || process.env.DALLE3_API_KEY || process.env.DALLE_API_KEY;

    if (!openaiApiKey) {
      throw new Error(
        'OpenAI API key is required for generating images but was not found in environment variables',
      );
    }

    const dalleResponse = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        prompt: prompt,
        n: 1, // Generate one image
        size: '1024x1024',
      }),
    });

    const dalleData = await dalleResponse.json();
    if (!dalleResponse.ok || !dalleData.data || !dalleData.data[0].url) {
      throw new Error(
        `Failed to generate AI image: ${dalleData.error?.message || 'Unknown error'}`,
      );
    }

    const imageUrl = dalleData.data[0].url;

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error('Failed to download AI-generated image.');
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const fileName = `ai-image-${Date.now()}.png`;

    const imageBase64 = Buffer.from(imageBuffer).toString('base64');

    const response = await fetch(`${this.baseUrl}/wp-json/custom/v1/set-ai-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        postId,
        imageBase64,
        title: 'Image',
        caption: '',
        altText: '',
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to set AI image: ${data.message || 'Unknown error'}`);
    }

    return {
      message: 'AI Image uploaded successfully and set as featured',
      imageUrl: data.image_url,
      mediaId: data.attachment_id,
    };
  }

  async _call(args) {
    try {
      const validationResult = this.schema.safeParse(args);
      if (!validationResult.success) {
        return `Validation Error: ${JSON.stringify(validationResult.error.issues)}`;
      }

      const {
        action,
        title,
        content,
        status,
        type,
        tags,
        categories,
        postId,
        date,
        searchType,
        searchValue,
        tagId,
        tagName,
        categoryId,
        categoryName,
        metaKey,
        metaValue,
        description,
        name,
        page,
        perPage,
        imageUrl,
        width,
        height,
        imageBase64,
        caption,
        altText,
        mediaId,
        prompt,
      } = validationResult.data;

      const token = await this.getToken();

      switch (action) {
        case 'listPosts': {
          const posts = await this.listPosts(token);
          return JSON.stringify(posts.map((post) => ({ id: post.id, title: post.title.rendered })));
        }
        case 'createPost': {
          if (!title || !content) {
            return JSON.stringify({
              error: 'Title and content are required for creating a post or page.',
            });
          }
          const result = await this.createPost(
            token,
            title,
            content,
            status || 'draft',
            type || 'post',
            tags || [],
            categories || [],
            date,
          );
          return JSON.stringify({
            message: `${type} created successfully`,
            id: result.id,
            title: result.title.rendered,
          });
        }
        case 'editPost': {
          if (!postId) {
            return JSON.stringify({ error: 'postId is required for editing a post or page.' });
          }

          // Collect only provided fields to update
          let updatedFields = {};
          if (title) {
            updatedFields.title = title;
          }
          if (content) {
            updatedFields.content = content;
          }
          if (status) {
            updatedFields.status = status;
          }
          if (tags) {
            updatedFields.tags = tags;
          }
          if (categories) {
            updatedFields.categories = categories;
          }

          if (Object.keys(updatedFields).length === 0) {
            return JSON.stringify({ error: 'No fields provided for update.' });
          }

          const result = await this.editPost(token, postId, updatedFields);
          return JSON.stringify({
            message: 'Post updated successfully',
            id: result.id,
            updatedFields,
          });
        }
        case 'deletePost': {
          if (!postId) {
            return 'Error: postId is required for deleting a post.';
          }
          const response = await this.deletePost(token, postId);
          return JSON.stringify({ message: 'Post deleted successfully', postId: response.id });
        }
        case 'searchPosts': {
          const posts = await this.searchPosts(
            token,
            searchType,
            searchValue,
            tagId,
            tagName,
            categoryId,
            categoryName,
            type || 'post',
          );
          return JSON.stringify(posts.map((post) => ({ id: post.id, title: post.title.rendered })));
        }
        case 'listCategories': {
          const categories = await this.listCategories(token);
          return JSON.stringify(categories);
        }
        case 'listTags': {
          const tags = await this.listTags(token);
          return JSON.stringify(tags);
        }
        case 'searchByMeta': {
          if (!metaKey || !metaValue) {
            return JSON.stringify({ error: 'Meta key and value are required for searching.' });
          }
          const posts = await this.searchByMeta(token, metaKey, metaValue, type || 'post');
          return JSON.stringify(posts.map((post) => ({ id: post.id, title: post.title.rendered })));
        }
        case 'updatePostMeta': {
          if (!postId || !metaKey || !metaValue) {
            return JSON.stringify({
              error: 'postId, metaKey, and metaValue are required for updating meta.',
            });
          }
          const result = await this.updatePostMeta(token, postId, metaKey, metaValue);
          return JSON.stringify({
            message: 'Post meta updated successfully',
            postId: result.id,
          });
        }
        case 'getPostMeta': {
          if (!postId) {
            return JSON.stringify({ error: 'postId is required to fetch post meta.' });
          }
          const meta = await this.getPostMeta(token, postId);
          return JSON.stringify({ postId, meta });
        }
        case 'deletePostMeta': {
          if (!postId || !metaKey) {
            return JSON.stringify({ error: 'postId is required to fetch post meta.' });
          }
          const result = await this.deletePostMeta(token, postId, metaKey);
          return JSON.stringify({
            message: 'Post meta deleted successfully',
            postId: result.id,
          });
        }

        case 'updateCategory': {
          if (!categoryId) {
            return JSON.stringify({ error: 'categoryId is required.' });
          }

          if (!name && !description) {
            return JSON.stringify({ error: 'At least one of name or description is required.' });
          }

          try {
            const result = await this.updateCategoryOrTag(
              token,
              categoryId,
              name,
              description,
              'categories',
            );
            return JSON.stringify(result);
          } catch (error) {
            return JSON.stringify({ error: error.message });
          }
        }

        case 'updateTag': {
          if (!tagId) {
            return JSON.stringify({ error: 'tagId is required.' });
          }

          if (!name && !description) {
            return JSON.stringify({ error: 'At least one of name or description is required.' });
          }

          try {
            const result = await this.updateCategoryOrTag(token, tagId, name, description, 'tags');
            return JSON.stringify(result);
          } catch (error) {
            return JSON.stringify({ error: error.message });
          }
        }

        case 'addCategory': {
          if (!name) {
            return JSON.stringify({ error: 'Category name is required.' });
          }
          const category = await this.addCategory(token, name, description);
          return JSON.stringify(category);
        }

        case 'addTag': {
          if (!name) {
            return JSON.stringify({ error: 'Tag name is required.' });
          }
          const tag = await this.addTag(token, name, description);
          return JSON.stringify(tag);
        }

        case 'deleteCategory': {
          if (!categoryId) {
            return JSON.stringify({ error: 'Category ID is required.' });
          }
          const deletedCategory = await this.deleteCategory(token, categoryId);
          return JSON.stringify(deletedCategory);
        }

        case 'deleteTag': {
          if (!tagId) {
            return JSON.stringify({ error: 'Tag ID is required.' });
          }
          const deletedTag = await this.deleteTag(token, tagId);
          return JSON.stringify(deletedTag);
        }

        case 'listPaginatedPosts': {
          const posts = await this.listPaginatedPosts(token, page, perPage);
          return JSON.stringify(
            posts.map((post) => ({
              id: post.id,
              title: post.title,
              status: post.status, // Return the status field
            })),
          );
        }
        case 'getPostContentById': {
          if (!postId) {
            return JSON.stringify({ error: 'postId is required' });
          }
          const content = await this.getPostContentById(token, postId);
          return JSON.stringify({ postId, content });
        }
        case 'getFeaturedImage': {
          if (!postId) {
            return JSON.stringify({ error: 'postId is required' });
          }
          const imageUrl = await this.getFeaturedImage(token, postId);
          return JSON.stringify({ postId, imageUrl });
        }
        case 'listPaginatedCategories': {
          const categories = await this.listPaginatedCategories(token, page, perPage);
          return JSON.stringify(categories);
        }
        case 'listPaginatedTags': {
          const tags = await this.listPaginatedTags(token, page, perPage);
          return JSON.stringify(tags);
        }

        case 'uploadImageFromURL': {
          if (!imageUrl || !postId) {
            return JSON.stringify({ error: 'Image URL and postId are required.' });
          }
          const result = await this.uploadImageFromURL(token, imageUrl, width, height, postId);
          return JSON.stringify(result);
        }

        case 'setAIImageAsFeatured': {
          if (!postId || !imageBase64) {
            return JSON.stringify({ error: 'Post ID and Image Base64 data are required.' });
          }
          const result = await this.setAIImageAsFeatured(
            token,
            postId,
            imageBase64,
            title,
            caption,
            altText,
          );
          return JSON.stringify(result);
        }

        case 'updateImageMeta': {
          if (!postId && !mediaId) {
            return JSON.stringify({
              error: 'Either postId or mediaId is required to update image metadata.',
            });
          }
          const result = await this.updateImageMeta(
            token,
            postId,
            mediaId,
            title,
            caption,
            altText,
          );
          return JSON.stringify(result);
        }

        case 'generateAndUploadAIImage': {
          if (!postId || !prompt) {
            return JSON.stringify({ error: 'postId and prompt are required.' });
          }
          const result = await this.generateAndUploadAIImage(token, prompt, postId);
          return JSON.stringify(result);
        }

        default:
          return JSON.stringify({ error: `Unsupported action "${action}".` });
      }
    } catch (error) {
      console.error(error);
      return JSON.stringify({ error: error.message });
    }
  }
}

module.exports = WordPress;
