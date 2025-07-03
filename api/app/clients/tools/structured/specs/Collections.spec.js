const Collections = require('../Collections'); // Update path as needed
const { Pool } = require('pg');
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

// Mock dependencies
jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return { Pool: jest.fn(() => mockPool) };
});

jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Collections', () => {
  let collections;
  let mockPool;
  let mockClient;

  beforeEach(async () => {
    // Clear all mock calls
    jest.clearAllMocks();

    // Create a mock client FIRST
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    // Set up the mock pool to return our mockClient
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      end: jest.fn().mockResolvedValue(undefined),
    };

    // Update the Pool mock implementation to return our mockPool
    require('pg').Pool.mockImplementation(() => mockPool);

    // THEN setup the collections instance with a test user ID
    collections = new Collections({ userId: 'test-user-id' });

    // Wait for initialization to complete
    await collections.ready;
  });

  afterEach(async () => {
    await collections.close();
  });

  describe('Constructor', () => {
    it('should initialize with default values', () => {
      const instance = new Collections();
      expect(instance.userId).toBeNull();
      expect(instance.name).toBe('collections');
      expect(instance.description).toBeDefined();
      expect(instance.schema).toBeDefined();
    });

    it('should initialize with provided userId', () => {
      const userId = 'test-user';
      const instance = new Collections({ userId });
      expect(instance.userId).toBe(userId);
    });

    it('should initialize the database connection', async () => {
      await collections.ready;
      expect(Pool).toHaveBeenCalled();
      expect(mockPool.connect).toHaveBeenCalled();
    });
  });

  describe('Input Sanitization', () => {
    it('should sanitize text', () => {
      const result = collections.sanitizeText('Test \x00text with \x1Fcontrol chars');
      expect(result).toBe('Test text with control chars');
    });

    it('should sanitize URLs', () => {
      const validUrl = collections.sanitizeUrl('https://example.com');
      expect(validUrl).toBe('https://example.com');

      const noProtocolUrl = collections.sanitizeUrl('example.com');
      expect(noProtocolUrl).toBe('example.com');

      const maliciousUrl = collections.sanitizeUrl('javascript:alert(1)');
      expect(maliciousUrl).toBeNull();
    });

    it('should sanitize arrays', () => {
      const result = collections.sanitizeArray(['valid', '', 'also valid']);
      expect(result).toEqual(['valid', 'also valid']);
    });

    it('should sanitize search queries', () => {
      const result = collections.sanitizeSearchQuery('Test; DROP TABLE users;');
      expect(result).toBe('Test DROP TABLE users');
    });
  });

  describe('Database Operations', () => {
    it('should ensure tables exist on initialization', async () => {
      await collections.ready;

      // Verify the extension creation queries
      expect(mockClient.query).toHaveBeenCalledWith('CREATE EXTENSION IF NOT EXISTS vector');
      expect(mockClient.query).toHaveBeenCalledWith('CREATE EXTENSION IF NOT EXISTS pgcrypto');

      // Verify table creation queries
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS collections'),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS notes'),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS note_vectors'),
      );

      // Verify index creation queries
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS'),
      );
    });

    it('should close the database connection', async () => {
      await collections.close();
      expect(mockPool.end).toHaveBeenCalled();
    });
  });

  describe('Embedding Generation', () => {
    it('should generate embeddings using OpenAI API', async () => {
      // Mock environment variable
      process.env.OPENAI_API_KEY = 'test-api-key';

      // Mock successful API response
      axios.post.mockResolvedValueOnce({
        data: {
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        },
      });

      const result = await collections.generateEmbedding('Test text');

      expect(axios.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        {
          input: 'Test text',
          model: 'text-embedding-3-small',
        },
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        }),
      );

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('should handle errors during embedding generation', async () => {
      process.env.OPENAI_API_KEY = 'test-api-key';
      axios.post.mockRejectedValueOnce(new Error('API error'));

      const result = await collections.generateEmbedding('Test text');

      expect(logger.error).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('should truncate long text for embedding generation', async () => {
      process.env.OPENAI_API_KEY = 'test-api-key';
      axios.post.mockResolvedValueOnce({
        data: {
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        },
      });

      // Create text longer than the limit (30000 chars)
      const longText = 'a'.repeat(35000);
      await collections.generateEmbedding(longText);

      // Verify truncation
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.stringMatching(/^a{1,30000}$/),
        }),
        expect.any(Object),
      );

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('Collection Management', () => {
    describe('createCollection', () => {
      it('should create a new collection', async () => {
        const mockCollection = {
          id: 'test-id',
          name: 'Test Collection',
          description: 'Test Description',
          tags: ['tag1', 'tag2'],
          parent_id: null,
          created_at: new Date().toISOString(),
        };

        mockClient.query.mockResolvedValueOnce({ rows: [mockCollection] });

        const result = await collections.createCollection('Test Collection', 'Test Description', [
          'tag1',
          'tag2',
        ]);

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO collections'),
          ['test-user-id', 'Test Collection', 'Test Description', ['tag1', 'tag2'], null],
        );

        expect(result).toEqual(mockCollection);
      });

      it('should validate parent collection existence', async () => {
        const parentId = 'parent-id';

        // First query to check parent exists returns empty
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await expect(
          collections.createCollection(
            'Test Collection',
            'Test Description',
            ['tag1', 'tag2'],
            parentId,
          ),
        ).rejects.toThrow('Parent collection not found or access denied');

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('SELECT id FROM collections'),
          [parentId, 'test-user-id'],
        );
      });

      it('should throw error if name is empty', async () => {
        await expect(collections.createCollection('')).rejects.toThrow(
          'Collection name is required',
        );
      });
    });

    describe('updateCollection', () => {
      it('should update a collection', async () => {
        const collectionId = 'test-collection-id';
        const mockCollection = {
          id: collectionId,
          name: 'Updated Name',
          updated_at: new Date().toISOString(),
        };

        // Mock the collection check query
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: collectionId }] });
        // Mock the update query
        mockClient.query.mockResolvedValueOnce({ rows: [mockCollection] });

        const result = await collections.updateCollection(collectionId, {
          name: 'Updated Name',
        });

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE collections'),
          expect.arrayContaining([collectionId, 'Updated Name']),
        );

        expect(result).toEqual(mockCollection);
      });

      it('should check for circular references when updating parent', async () => {
        const collectionId = 'test-collection-id';
        const parentId = 'parent-id';

        // Mock the collection check query
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: collectionId }] });
        // Mock the parent check query
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: parentId }] });
        // Mock circular reference check
        mockClient.query.mockResolvedValueOnce({ rows: [{ cycle_count: '1' }] });

        await expect(
          collections.updateCollection(collectionId, {
            parent_id: parentId,
          }),
        ).rejects.toThrow('Cannot set parent: would create circular reference');
      });
    });

    describe('deleteCollection', () => {
      it('should delete a collection', async () => {
        const collectionId = 'test-collection-id';
        const mockCollection = {
          id: collectionId,
          name: 'Test Collection',
        };

        // Mock the collection check query
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: collectionId }] });
        // Mock transaction queries
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [mockCollection] }); // DELETE
        mockClient.query.mockResolvedValueOnce({}); // COMMIT

        const result = await collections.deleteCollection(collectionId);

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('DELETE FROM collections'),
          [collectionId],
        );
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');

        expect(result).toEqual(mockCollection);
      });

      it('should handle collection not found', async () => {
        const collectionId = 'nonexistent-id';

        // Mock the collection check query - empty result
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await expect(collections.deleteCollection(collectionId)).rejects.toThrow(
          'Collection not found or access denied',
        );
      });
    });
  });

  describe('Note Management', () => {
    describe('addNote', () => {
      it('should add a note to a collection', async () => {
        const collectionId = 'test-collection-id';
        const mockNote = {
          id: 'test-note-id',
          title: 'Test Note',
          content: 'Test Content',
          source_url: 'https://example.com',
          tags: ['tag1', 'tag2'],
          created_at: new Date().toISOString(),
        };

        // Mock queries
        mockClient.query.mockResolvedValueOnce({}); // BEGIN
        mockClient.query.mockResolvedValueOnce({ rows: [{ id: collectionId }] }); // Collection check
        mockClient.query.mockResolvedValueOnce({ rows: [mockNote] }); // Insert note
        mockClient.query.mockResolvedValueOnce({}); // Update collection timestamp
        mockClient.query.mockResolvedValueOnce({}); // COMMIT

        // Mock embedding generation
        jest.spyOn(collections, 'generateEmbedding').mockResolvedValueOnce([0.1, 0.2, 0.3]);

        const result = await collections.addNote(
          collectionId,
          'Test Note',
          'Test Content',
          'https://example.com',
          ['tag1', 'tag2'],
        );

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO notes'),
          [collectionId, 'Test Note', 'Test Content', 'https://example.com', ['tag1', 'tag2']],
        );
        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO note_vectors'),
          expect.anything(),
        );
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');

        expect(result).toEqual(mockNote);
      });

      it('should validate required fields', async () => {
        const collectionId = 'test-collection-id';

        await expect(collections.addNote(collectionId, '', 'Content')).rejects.toThrow(
          'Note title is required',
        );

        await expect(collections.addNote(collectionId, 'Title', '')).rejects.toThrow(
          'Note content is required',
        );
      });
    });

    describe('bulkAddNotes', () => {
      it('should add multiple notes in bulk', async () => {
        const collectionId = 'test-collection-id';

        // Set up a counter to return different note IDs for each insertion
        let noteCounter = 0;

        mockClient.query.mockImplementation((query, params) => {
          if (query.includes('INSERT INTO notes')) {
            noteCounter++;
            return Promise.resolve({
              rows: [
                {
                  id: `note-${noteCounter}`,
                  title: params[1], // The title parameter
                  content: params[2], // The content parameter
                  created_at: new Date().toISOString(),
                  collection_id: collectionId,
                },
              ],
            });
          }
          // Return specific responses based on the query content and call order
          if (query === 'BEGIN') {
            return Promise.resolve({});
          } else if (query.includes('SELECT id FROM collections')) {
            return Promise.resolve({ rows: [{ id: collectionId }] });
          } else if (query.includes('INSERT INTO notes')) {
            // First note insertion succeeds
            if (params[1] === 'Note 1') {
              return Promise.resolve({ rows: [mockNote] });
            }
            // Second note insertion fails
            else if (params[1] === 'Note 2') {
              return Promise.reject(new Error('Database error'));
            }
            return Promise.resolve({ rows: [] });
          } else if (query.includes('INSERT INTO note_vectors')) {
            return Promise.resolve({});
          } else if (query.includes('UPDATE collections')) {
            return Promise.resolve({});
          } else if (query === 'COMMIT') {
            return Promise.resolve({});
          } else {
            return Promise.resolve({ rows: [] });
          }
        });

        // Mock embedding generation to avoid that error
        jest.spyOn(collections, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3]);

        const result = await collections.bulkAddNotes(collectionId, [
          { title: 'Note 1', content: 'Content 1' },
          { title: 'Note 2', content: 'Content 2' },
        ]);

        expect(result.totalRequested).toBe(2);
        expect(result.totalCreated).toBe(2);
        expect(result.createdNotes.length).toBe(2);
      });

      it('should handle failures for individual notes', async () => {
        const collectionId = 'test-collection-id';
        const mockNote = {
          id: 'note-1',
          title: 'Note 1',
          content: 'Content 1',
          created_at: new Date().toISOString(),
        };

        // Create a counter to track query calls and make specific ones fail
        let queryCounter = 0;

        // Mock queries with a custom implementation for this test
        mockClient.query.mockImplementation((query, params) => {
          queryCounter++;

          // Return specific responses based on the query content and call order
          if (query === 'BEGIN') {
            return Promise.resolve({});
          } else if (query.includes('SELECT id FROM collections')) {
            return Promise.resolve({ rows: [{ id: collectionId }] });
          } else if (query.includes('INSERT INTO notes')) {
            // First note insertion succeeds
            if (params[1] === 'Note 1') {
              return Promise.resolve({ rows: [mockNote] });
            }
            // Second note insertion fails
            else if (params[1] === 'Note 2') {
              return Promise.reject(new Error('Database error'));
            }
            return Promise.resolve({ rows: [] });
          } else if (query.includes('INSERT INTO note_vectors')) {
            return Promise.resolve({});
          } else if (query.includes('UPDATE collections')) {
            return Promise.resolve({});
          } else if (query === 'COMMIT') {
            return Promise.resolve({});
          } else {
            return Promise.resolve({ rows: [] });
          }
        });

        // Mock embedding generation
        jest.spyOn(collections, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3]);

        const result = await collections.bulkAddNotes(collectionId, [
          { title: 'Note 1', content: 'Content 1' },
          { title: 'Note 2', content: 'Content 2' },
        ]);

        expect(result.totalRequested).toBe(2);
        expect(result.totalCreated).toBe(1);
        expect(result.totalFailed).toBe(1);
        expect(result.failedNotes).toHaveLength(1);
        expect(result.failedNotes[0].title).toBe('Note 2');
        expect(result.failedNotes[0].error).toBeDefined();
      });
    });

    describe('searchNotes', () => {
      it('should search notes with keyword mode', async () => {
        const mockNotes = [
          {
            id: 'note-1',
            title: 'Note 1',
            content: 'Content 1',
            collection_name: 'Test Collection',
            collection_path: '',
            score: 0.9,
            created_at: new Date().toISOString(),
          },
        ];

        mockClient.query.mockResolvedValueOnce({ rows: mockNotes });

        const result = await collections.searchNotes({
          searchQuery: 'test query',
          searchMode: 'keyword',
          returnMode: 'lite',
        });

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining("to_tsvector('english', n.content)"),
          expect.arrayContaining(['test-user-id', 'test query']),
        );

        expect(result).toEqual(mockNotes);
      });

      it('should search notes with semantic mode', async () => {
        const mockNotes = [
          {
            id: 'note-1',
            title: 'Note 1',
            content: 'Content 1',
            collection_name: 'Test Collection',
            collection_path: '',
            score: 0.8,
            created_at: new Date().toISOString(),
          },
        ];

        // Mock embedding generation
        jest.spyOn(collections, 'generateEmbedding').mockResolvedValueOnce([0.1, 0.2, 0.3]);
        mockClient.query.mockResolvedValueOnce({ rows: mockNotes });

        const result = await collections.searchNotes({
          searchQuery: 'test query',
          searchMode: 'semantic',
          returnMode: 'full',
        });

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('LEFT JOIN note_vectors v ON n.id = v.note_id'),
          expect.arrayContaining(['test-user-id']),
        );

        expect(result).toEqual(mockNotes);
      });

      it('should search notes with hybrid mode', async () => {
        const mockNotes = [
          {
            id: 'note-1',
            title: 'Note 1',
            content: 'Content 1',
            collection_name: 'Test Collection',
            collection_path: '',
            score: 0.85,
            created_at: new Date().toISOString(),
          },
        ];

        // Mock embedding generation
        jest.spyOn(collections, 'generateEmbedding').mockResolvedValueOnce([0.1, 0.2, 0.3]);
        mockClient.query.mockResolvedValueOnce({ rows: mockNotes });

        const result = await collections.searchNotes({
          searchQuery: 'test query',
          searchMode: 'hybrid',
        });

        expect(mockClient.query).toHaveBeenCalledWith(
          expect.stringContaining('WITH keyword_scores AS'),
          expect.arrayContaining(['test-user-id', 'test query']),
        );

        expect(result).toEqual(mockNotes);
      });
    });
  });

  describe('_call Method', () => {
    it('should handle create_collection action', async () => {
      const mockCollection = {
        id: 'test-id',
        created_at: new Date().toISOString(),
      };

      // Mock createCollection method
      jest.spyOn(collections, 'createCollection').mockResolvedValueOnce(mockCollection);

      const result = await collections._call({
        action: 'create_collection',
        collection_name: 'Test Collection',
        collection_description: 'Test Description',
        collection_tags: ['tag1', 'tag2'],
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.success).toBe(true);
      expect(parsedResult.id).toBe('test-id');
      expect(collections.createCollection).toHaveBeenCalledWith(
        'Test Collection',
        'Test Description',
        ['tag1', 'tag2'],
        null,
      );
    });

    it('should handle search_notes action', async () => {
      const mockNotes = [
        {
          id: 'note-1',
          title: 'Note 1',
          score: 0.9,
          created_at: new Date().toISOString(),
        },
      ];

      // Mock searchNotes method
      jest.spyOn(collections, 'searchNotes').mockResolvedValueOnce(mockNotes);

      const result = await collections._call({
        action: 'search_notes',
        search_query: 'test query',
        search_mode: 'hybrid',
        return_mode: 'lite',
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.success).toBe(true);
      expect(parsedResult.notes).toEqual(expect.any(Array));
      expect(collections.searchNotes).toHaveBeenCalledWith(
        expect.objectContaining({
          searchQuery: 'test query',
          searchMode: 'hybrid',
          returnMode: 'lite',
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      // Force an error
      jest.spyOn(collections, 'createCollection').mockRejectedValueOnce(new Error('Test error'));

      const result = await collections._call({
        action: 'create_collection',
        collection_name: 'Test Collection',
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.error).toBe('Test error');
      expect(logger.error).toHaveBeenCalled();
    });

    it('should validate inputs against schema', async () => {
      const result = await collections._call({
        action: 'create_collection',
        // Missing required collection_name
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.error).toBeDefined();
    });
  });
});
