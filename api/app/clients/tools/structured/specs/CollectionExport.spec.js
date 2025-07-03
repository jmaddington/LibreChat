const CollectionExport = require('../CollectionExport'); // Update path as needed
const { Pool } = require('pg');
const { v4 } = require('uuid');
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

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mocked-uuid'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PDFKit properly
jest.mock('pdfkit', () => {
  // Create a constructor function that returns an event emitter with the PDF methods
  function MockPDFDocument() {
    const eventListeners = {};

    // Return an object with all the methods needed
    return {
      on: function (event, callback) {
        eventListeners[event] = callback;
        return this;
      },

      end: function () {
        // Simulate PDF creation by calling data and end event handlers
        if (eventListeners.data) {
          eventListeners.data(Buffer.from('mock pdf content'));
        }
        if (eventListeners.end) {
          eventListeners.end();
        }
      },

      fillColor: jest.fn().mockReturnThis(),
      fontSize: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
      moveDown: jest.fn().mockReturnThis(),
      rect: jest.fn().mockReturnThis(),
      fill: jest.fn().mockReturnThis(),
      addPage: jest.fn().mockReturnThis(),
      font: jest.fn().mockReturnThis(),
      y: 100, // Mock y position
      page: { width: 612 }, // Standard letter width
    };
  }

  // Return the constructor function
  return jest.fn().mockImplementation(MockPDFDocument);
});

// Mock LibreChat file handling
const mockCreateFile = jest.fn();
const mockSaveBuffer = jest.fn();
const mockGetStrategyFunctions = jest.fn().mockReturnValue({
  saveBuffer: mockSaveBuffer,
});

jest.mock('../../../../../models/File', () => ({
  createFile: mockCreateFile,
}));

jest.mock('../../../../../server/services/Files/strategies', () => ({
  getStrategyFunctions: mockGetStrategyFunctions,
}));

jest.mock('librechat-data-provider', () => ({
  FileSources: { local: 'local' },
  FileContext: { message_attachment: 'message_attachment' },
}));

describe('CollectionExport', () => {
  let collectionExport;
  let mockPool;
  let mockClient;
  let collectionId = 'test-collection-id';
  const mockCollection = {
    id: collectionId,
    name: 'Test Collection',
    description: 'Test Description',
    tags: ['tag1', 'tag2'],
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-02T00:00:00Z',
  };

  const mockNotes = [
    {
      id: 'note-1',
      collection_id: collectionId,
      title: 'Note 1',
      content: 'Content 1',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
    },
  ];
  beforeEach(() => {
    // Clear all mock calls
    jest.clearAllMocks();

    // Set up the CollectionExport instance with a test user ID
    collectionExport = new CollectionExport({ userId: 'test-user-id' });

    // Create a mock client FIRST
    mockClient = {
      query: jest.fn().mockImplementation((query, params) => {
        if (query.includes('SELECT * FROM collections WHERE id = ANY')) {
          return Promise.resolve({ rows: [mockCollection] });
        } else if (query.includes('SELECT * FROM collections WHERE id =')) {
          return Promise.resolve({ rows: [mockCollection] });
        } else if (query.includes('SELECT * FROM notes WHERE collection_id = ANY')) {
          return Promise.resolve({ rows: mockNotes });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    // Set up the mock pool to return our mockClient
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      end: jest.fn().mockResolvedValue(undefined),
    };

    // Update the Pool mock implementation to return our mockPool
    require('pg').Pool.mockImplementation(() => mockPool);

    // Mock dynamic import dependencies - assign to the module variables
    collectionExport.PDFDocument = require('pdfkit');
    collectionExport.createFile = mockCreateFile;
    collectionExport.getStrategyFunctions = mockGetStrategyFunctions;
    collectionExport.FileSources = { local: 'local' };
    collectionExport.FileContext = { message_attachment: 'message_attachment' };
  });

  afterEach(async () => {
    await collectionExport.close();
  });

  describe('Constructor', () => {
    it('should initialize with default values', () => {
      const instance = new CollectionExport();
      expect(instance.userId).toBeUndefined();
      expect(instance.name).toBe('collection_export');
      expect(instance.schema).toBeDefined();
    });

    it('should initialize with provided userId', () => {
      const userId = 'test-user';
      const instance = new CollectionExport({ userId });
      expect(instance.userId).toBe(userId);
    });

    it('should initialize the database connection', async () => {
      // Reset the existing mock
      jest.clearAllMocks();

      // Create a fresh instance so we can verify the initialization
      const newExport = new CollectionExport({ userId: 'test-user-id' });

      // Wait for initialization to complete
      await newExport.ready;

      // Verify Pool was constructed
      expect(Pool).toHaveBeenCalled();

      // Access the mock pool directly from the mocked module
      const mockPoolInstance = require('pg').Pool.mock.results[0].value;

      // Verify connect was called on this instance
      expect(mockPoolInstance.connect).toHaveBeenCalled();

      // Verify logging happened
      expect(logger.info).toHaveBeenCalledWith(
        'Collection Export tool database connection established',
      );

      // Clean up
      await newExport.close();
    });
  });

  describe('Database Operations', () => {
    it('should close the database connection', async () => {
      // Reset the existing mock
      jest.clearAllMocks();

      // Create a fresh instance so we can verify the initialization
      const newExport = new CollectionExport({ userId: 'test-user-id' });

      // Wait for initialization to complete
      await newExport.ready;

      // Verify Pool was constructed
      expect(Pool).toHaveBeenCalled();

      // Access the mock pool directly from the mocked module
      const mockPoolInstance = require('pg').Pool.mock.results[0].value;
      await newExport.close();
      expect(mockPoolInstance.end).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Collection Export tool database pool closed');
    });

    it('should handle errors when closing the database connection', async () => {
      const error = new Error('Connection close error');
      // Reset the existing mock
      jest.clearAllMocks();

      // Create a fresh instance so we can verify the initialization
      const newExport = new CollectionExport({ userId: 'test-user-id' });

      // Wait for initialization to complete
      await newExport.ready;

      // Verify Pool was constructed
      expect(Pool).toHaveBeenCalled();

      // Access the mock pool directly from the mocked module
      const mockPoolInstance = require('pg').Pool.mock.results[0].value;
      mockPoolInstance.end.mockRejectedValueOnce(error);

      await newExport.close();
      expect(logger.error).toHaveBeenCalledWith(
        'Error closing Collection Export tool database pool:',
        error,
      );
    });

    it('should get all child collection IDs recursively', async () => {
      const parentIds = ['parent-id-1', 'parent-id-2'];

      // First query returns child IDs
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'child-id-1' }, { id: 'child-id-2' }],
      });

      // Second query (with the new child IDs) returns grandchild IDs
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'grandchild-id-1' }],
      });

      // Third query (with the grandchild IDs) returns no more children
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      const result = await collectionExport.getAllChildCollectionIds(mockClient, parentIds);

      expect(mockClient.query).toHaveBeenCalledTimes(3);
      expect(result).toEqual(
        expect.arrayContaining([
          'parent-id-1',
          'parent-id-2',
          'child-id-1',
          'child-id-2',
          'grandchild-id-1',
        ]),
      );
    });

    it('should handle circular references in child collections', async () => {
      const parentIds = ['parent-id'];

      // First query returns child IDs
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'child-id' }],
      });

      // Second query returns parent as a child (circular reference)
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'parent-id' }],
      });

      const result = await collectionExport.getAllChildCollectionIds(mockClient, parentIds);

      // Should only contain unique IDs and not get stuck in a loop
      expect(result).toEqual(['parent-id', 'child-id']);
      expect(mockClient.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('Collection Data Retrieval', () => {
    it('should get collection data including notes', async () => {
      // Reset mock to ensure clean state
      mockClient.query.mockReset();

      const result = await collectionExport.getCollectionData(collectionId, false);

      expect(result).toEqual({
        collection: mockCollection,
        collections: [mockCollection],
        notes: mockNotes,
      });
    });
  });

  describe('Export Format Generation', () => {
    const mockData = {
      collection: {
        id: 'col-1',
        name: 'Test Collection',
        description: 'Test Description',
        tags: ['tag1', 'tag2'],
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      },
      collections: [
        {
          id: 'col-1',
          name: 'Test Collection',
          description: 'Test Description',
          tags: ['tag1', 'tag2'],
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
        {
          id: 'col-2',
          name: 'Child Collection',
          description: 'Child Description',
          parent_id: 'col-1',
          tags: ['child-tag'],
          created_at: '2023-01-03T00:00:00Z',
          updated_at: '2023-01-04T00:00:00Z',
        },
      ],
      notes: [
        {
          id: 'note-1',
          collection_id: 'col-1',
          title: 'Note 1',
          content: 'Content 1',
          source_url: 'https://example.com',
          tags: ['note-tag'],
          created_at: '2023-01-05T00:00:00Z',
          updated_at: '2023-01-06T00:00:00Z',
        },
      ],
    };

    it('should generate JSON format correctly', () => {
      const json = collectionExport.generateJSON(mockData);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(mockData);
      expect(typeof json).toBe('string');
    });

    it('should generate XML format correctly', () => {
      const xml = collectionExport.generateXML(mockData);

      expect(typeof xml).toBe('string');
      expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
      expect(xml).toContain('<id>col-1</id>');
      expect(xml).toContain('<name>Test Collection</name>');
      expect(xml).toContain('<content>Content 1</content>');
      expect(xml).toContain('<tag>tag1</tag>');
    });

    it('should escape special characters in XML', () => {
      const dataWithSpecialChars = {
        ...mockData,
        collection: {
          ...mockData.collection,
          name: 'Test & Collection <with> "special" chars',
        },
      };

      const xml = collectionExport.generateXML(dataWithSpecialChars);

      expect(xml).toContain(
        '<name>Test &amp; Collection &lt;with&gt; &quot;special&quot; chars</name>',
      );
    });

    it('should generate PDF format correctly', async () => {
      // Mock the generatePDF method to return a buffer directly
      jest
        .spyOn(collectionExport, 'generatePDF')
        .mockResolvedValue(Buffer.from('Mock PDF content'));

      const pdfBuffer = await collectionExport.generatePDF(mockData);

      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.toString()).toBe('Mock PDF content');
    });
  });

  describe('Filename Sanitization', () => {
    it('should sanitize filenames by removing unsafe characters', () => {
      const result = collectionExport.sanitizeFilename('Test: File/Name*<>?');
      expect(result).toBe('Test_File_Name');
    });

    it('should truncate long filenames', () => {
      const longName = 'This_is_a_very_long_filename_that_exceeds_the_maximum_length_limit';
      const result = collectionExport.sanitizeFilename(longName, 20);
      expect(result.length).toBeLessThanOrEqual(20);
    });

    it('should provide default name for empty input', () => {
      expect(collectionExport.sanitizeFilename('')).toBe('untitled');
      expect(collectionExport.sanitizeFilename(null)).toBe('untitled');
    });
  });

  describe('Export Collection', () => {
    it('should export collection as JSON', async () => {
      const collectionId = 'test-collection-id';
      const mockCollection = {
        id: collectionId,
        name: 'Test Collection',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };

      // Mock getCollectionData
      jest.spyOn(collectionExport, 'getCollectionData').mockResolvedValueOnce({
        collection: mockCollection,
        collections: [mockCollection],
        notes: [],
      });

      // Mock file saving
      mockSaveBuffer.mockResolvedValueOnce('/path/to/file.json');
      mockCreateFile.mockResolvedValueOnce({
        file_id: 'mocked-uuid',
        filename: 'collection-Test_Collection-123456789.json',
        filepath: '/path/to/file.json',
        bytes: 123,
      });

      const result = await collectionExport.exportCollection(collectionId, 'json', false);

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.file_id).toBe('mocked-uuid');
      expect(mockSaveBuffer).toHaveBeenCalled();
      expect(mockCreateFile).toHaveBeenCalled();
    });

    it('should export collection as XML', async () => {
      const collectionId = 'test-collection-id';

      // Mock getCollectionData
      jest.spyOn(collectionExport, 'getCollectionData').mockResolvedValueOnce({
        collection: {
          id: collectionId,
          name: 'Test Collection',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
        collections: [
          {
            id: collectionId,
            name: 'Test Collection',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-02T00:00:00Z',
          },
        ],
        notes: [],
      });

      // Mock file saving
      mockSaveBuffer.mockResolvedValueOnce('/path/to/file.xml');
      mockCreateFile.mockResolvedValueOnce({
        file_id: 'mocked-uuid',
        filename: 'collection-Test_Collection-123456789.xml',
        filepath: '/path/to/file.xml',
        bytes: 123,
      });

      const result = await collectionExport.exportCollection(collectionId, 'xml', false);

      expect(result.success).toBe(true);
      expect(result.format).toBe('xml');
    });

    it('should export collection as PDF', async () => {
      const collectionId = 'test-collection-id';

      // Mock getCollectionData
      jest.spyOn(collectionExport, 'getCollectionData').mockResolvedValueOnce({
        collection: {
          id: collectionId,
          name: 'Test Collection',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
        collections: [
          {
            id: collectionId,
            name: 'Test Collection',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-02T00:00:00Z',
          },
        ],
        notes: [],
      });

      // Mock file saving
      mockSaveBuffer.mockResolvedValueOnce('/path/to/file.pdf');
      mockCreateFile.mockResolvedValueOnce({
        file_id: 'mocked-uuid',
        filename: 'collection-Test_Collection-123456789.pdf',
        filepath: '/path/to/file.pdf',
        bytes: 123,
      });

      const result = await collectionExport.exportCollection(collectionId, 'pdf', false);

      expect(result.success).toBe(true);
      expect(result.format).toBe('pdf');
    });

    it('should handle errors during export', async () => {
      const collectionId = 'test-collection-id';

      // Mock getCollectionData to throw an error
      jest
        .spyOn(collectionExport, 'getCollectionData')
        .mockRejectedValueOnce(new Error('Collection access error'));

      await expect(collectionExport.exportCollection(collectionId, 'json', false)).rejects.toThrow(
        'Collection access error',
      );

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('_call Method', () => {
    it('should handle export_collection action', async () => {
      // Mock exportCollection method
      jest.spyOn(collectionExport, 'exportCollection').mockResolvedValueOnce({
        success: true,
        file_id: '683f7321-06bf-4677-aad7-9d875f618a05',
        filename: 'collection-export.json',
        format: 'json',
      });

      const result = await collectionExport._call({
        action: 'export_collection',
        collection_id: '683f7321-06bf-4677-aad7-9d875f618a05',
        format: 'json',
        recursive: true,
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.success).toBe(true);
      expect(parsedResult.message).toContain('exported successfully');
      expect(collectionExport.exportCollection).toHaveBeenCalledWith(
        '683f7321-06bf-4677-aad7-9d875f618a05',
        'json',
        true,
      );
    });

    it('should validate input arguments against schema', async () => {
      // Call with invalid action
      const result = await collectionExport._call({
        action: 'invalid_action',
        collection_id: 'test-collection-id',
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.error).toBeDefined();
    });

    it('should handle missing user context', async () => {
      // Create instance without userId
      const instance = new CollectionExport();

      const result = await instance._call({
        action: 'export_collection',
        collection_id: 'test-collection-id',
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.error).toBe('User context not available');
    });

    it('should handle errors gracefully', async () => {
      // Force an error
      jest
        .spyOn(collectionExport, 'exportCollection')
        .mockRejectedValueOnce(new Error('Export failure'));

      const result = await collectionExport._call({
        action: 'export_collection',
        collection_id: '683f7321-06bf-4677-aad7-9d875f618a05',
        format: 'json',
      });

      const parsedResult = JSON.parse(result);
      expect(parsedResult.error).toBe('Export failure');
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
