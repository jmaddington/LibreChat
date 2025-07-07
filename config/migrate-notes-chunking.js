#!/usr/bin/env node

/**
 * Migration script to chunk existing notes in the Collections tool
 * 
 * This script will:
 * 1. Find all notes that are not yet chunked (is_chunked = false)
 * 2. For large notes (>2000 characters), create chunks and embeddings
 * 3. Update the is_chunked flag to track migration status
 * 4. Provide detailed progress reporting
 * 
 * Usage:
 *   node scripts/migrate-notes-chunking.js [options]
 * 
 * Options:
 *   --dry-run    Show what would be done without making changes
 *   --batch-size Number of notes to process at once (default: 10)
 *   --verbose    Show detailed progress information
 */

const { Pool } = require('pg');
const axios = require('axios');
const tokenSplit = require('../api/app/clients/document/tokenSplit');

// Configuration
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;
const DEFAULT_BATCH_SIZE = 10;

class NoteMigration {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    this.verbose = options.verbose || false;
    
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST || 'vectordb',
      port: Number(process.env.POSTGRES_PORT) || 5432,
      database: process.env.POSTGRES_DB || 'mydatabase',
      user: process.env.POSTGRES_USER || 'myuser',
      password: process.env.POSTGRES_PASSWORD || 'mypassword',
    });

    this.stats = {
      totalNotes: 0,
      processedNotes: 0,
      chunkedNotes: 0,
      skippedNotes: 0,
      errorNotes: 0,
      totalChunks: 0,
      startTime: new Date(),
    };
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = this.dryRun ? '[DRY RUN] ' : '';
    
    if (level === 'verbose' && !this.verbose) {
      return;
    }
    
    console.log(`${timestamp} ${prefix}${message}`);
  }

  async generateEmbedding(text) {
    try {
      // Truncate text to handle OpenAI token limits
      const maxChars = 30000;
      let processedText = text;
      if (text && text.length > maxChars) {
        processedText = text.substring(0, maxChars);
        this.log(`Text truncated from ${text.length} to ${maxChars} characters for embedding`, 'verbose');
      }

      if (process.env.OPENAI_API_KEY) {
        const response = await axios.post(
          'https://api.openai.com/v1/embeddings',
          {
            input: processedText,
            model: 'text-embedding-3-small',
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          },
        );

        if (
          response.data &&
          response.data.data &&
          response.data.data[0] &&
          response.data.data[0].embedding
        ) {
          const embedding = response.data.data[0].embedding;
          return embedding.map((val) => (typeof val === 'string' ? parseFloat(val) : val));
        } else {
          this.log('OpenAI API returned invalid embedding response', 'error');
        }
      } else {
        this.log('No OpenAI API key configured for embeddings', 'error');
      }

      return null;
    } catch (error) {
      this.log(`Failed to generate embedding: ${error.message}`, 'error');
      return null;
    }
  }

  async createNoteChunks(noteId, title, content) {
    try {
      // Combine title and content for chunking
      const fullText = `${title}\n\n${content}`;
      
      // Check if content is large enough to warrant chunking
      if (fullText.length <= CHUNK_SIZE * 2) {
        // For smaller content, don't chunk - just create one chunk
        return [{
          content: fullText,
          chunk_index: 0,
          start_position: 0,
          end_position: fullText.length,
          token_count: Math.ceil(fullText.length / 4),
        }];
      }

      // Use the existing tokenSplit function
      const chunks = await tokenSplit({
        text: fullText,
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
        encodingName: 'cl100k_base',
      });

      // Calculate positions and create chunk objects
      const chunkObjects = [];
      let currentPosition = 0;
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const startPos = i === 0 ? 0 : Math.max(0, currentPosition - CHUNK_OVERLAP);
        const endPos = startPos + chunk.length;
        
        chunkObjects.push({
          content: chunk,
          chunk_index: i,
          start_position: startPos,
          end_position: endPos,
          token_count: Math.ceil(chunk.length / 4),
        });
        
        currentPosition = endPos;
      }

      return chunkObjects;
    } catch (error) {
      this.log(`Failed to create chunks for note ${noteId}: ${error.message}`, 'error');
      throw error;
    }
  }

  async storeNoteChunks(client, noteId, chunkObjects) {
    if (this.dryRun) {
      this.log(`Would create ${chunkObjects.length} chunks for note ${noteId}`, 'verbose');
      return chunkObjects;
    }

    try {
      const storedChunks = [];
      
      for (const chunkObj of chunkObjects) {
        // Insert chunk
        const chunkResult = await client.query(
          `INSERT INTO note_chunks (note_id, chunk_index, content, token_count, start_position, end_position) 
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            noteId,
            chunkObj.chunk_index,
            chunkObj.content,
            chunkObj.token_count,
            chunkObj.start_position,
            chunkObj.end_position,
          ],
        );
        
        const chunk = chunkResult.rows[0];
        
        // Generate and store embedding for this chunk
        const embedding = await this.generateEmbedding(chunkObj.content);
        if (embedding) {
          await client.query(
            'INSERT INTO note_chunk_vectors (chunk_id, embedding) VALUES ($1, $2)',
            [chunk.id, `[${embedding.join(',')}]`],
          );
          this.log(`Embedding stored for chunk ${chunk.id}`, 'verbose');
        } else {
          this.log(`Failed to generate embedding for chunk ${chunk.id}`, 'verbose');
        }
        
        storedChunks.push(chunk);
      }
      
      this.stats.totalChunks += storedChunks.length;
      return storedChunks;
    } catch (error) {
      this.log(`Failed to store chunks for note ${noteId}: ${error.message}`, 'error');
      throw error;
    }
  }

  shouldUseChunking(content) {
    return content && content.length > CHUNK_SIZE * 2;
  }

  async processNote(client, note) {
    try {
      const { id, title, content } = note;
      
      // Check if this note should be chunked
      const useChunking = this.shouldUseChunking(content);
      
      if (!useChunking) {
        this.log(`Skipping note ${id} - content too small for chunking (${content.length} chars)`, 'verbose');
        this.stats.skippedNotes++;
        return;
      }

      this.log(`Processing note ${id} - ${title} (${content.length} chars)`, 'verbose');

      // Create chunks
      const chunkObjects = await this.createNoteChunks(id, title, content);
      
      if (!this.dryRun) {
        await client.query('BEGIN');
        
        try {
          // Store chunks and embeddings
          await this.storeNoteChunks(client, id, chunkObjects);
          
          // Update is_chunked flag
          await client.query('UPDATE notes SET is_chunked = TRUE WHERE id = $1', [id]);
          
          await client.query('COMMIT');
          this.log(`Successfully chunked note ${id} into ${chunkObjects.length} chunks`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } else {
        this.log(`Would chunk note ${id} into ${chunkObjects.length} chunks`);
      }

      this.stats.chunkedNotes++;
      this.stats.processedNotes++;
    } catch (error) {
      this.log(`Error processing note ${note.id}: ${error.message}`, 'error');
      this.stats.errorNotes++;
      this.stats.processedNotes++;
    }
  }

  async getUnchunkedNotes(client, offset = 0, limit = null) {
    const actualLimit = limit || this.batchSize;
    
    const query = `
      SELECT id, title, content, LENGTH(content) as content_length
      FROM notes 
      WHERE is_chunked = FALSE OR is_chunked IS NULL
      ORDER BY created_at ASC
      LIMIT $1 OFFSET $2
    `;
    
    const result = await client.query(query, [actualLimit, offset]);
    return result.rows;
  }

  async getTotalUnchunkedCount(client) {
    const result = await client.query(
      'SELECT COUNT(*) as count FROM notes WHERE is_chunked = FALSE OR is_chunked IS NULL'
    );
    return parseInt(result.rows[0].count);
  }

  async run() {
    this.log('Starting note chunking migration...');
    
    if (this.dryRun) {
      this.log('Running in DRY RUN mode - no changes will be made');
    }

    const client = await this.pool.connect();
    
    try {
      // Get total count
      this.stats.totalNotes = await this.getTotalUnchunkedCount(client);
      this.log(`Found ${this.stats.totalNotes} notes to potentially chunk`);

      if (this.stats.totalNotes === 0) {
        this.log('No notes found that need chunking');
        return;
      }

      // Process notes in batches
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const notes = await this.getUnchunkedNotes(client, offset, this.batchSize);
        
        if (notes.length === 0) {
          hasMore = false;
          break;
        }

        this.log(`Processing batch ${Math.floor(offset / this.batchSize) + 1} (${notes.length} notes)...`);

        // Process each note in the batch
        for (const note of notes) {
          await this.processNote(client, note);
        }

        offset += this.batchSize;
        
        // Progress report
        const progress = ((this.stats.processedNotes / this.stats.totalNotes) * 100).toFixed(1);
        this.log(`Progress: ${this.stats.processedNotes}/${this.stats.totalNotes} (${progress}%)`);
      }

    } finally {
      client.release();
      await this.pool.end();
    }

    this.printSummary();
  }

  printSummary() {
    const duration = new Date() - this.stats.startTime;
    const durationSec = (duration / 1000).toFixed(1);
    
    this.log('\n=== MIGRATION SUMMARY ===');
    this.log(`Total notes found: ${this.stats.totalNotes}`);
    this.log(`Notes processed: ${this.stats.processedNotes}`);
    this.log(`Notes chunked: ${this.stats.chunkedNotes}`);
    this.log(`Notes skipped (too small): ${this.stats.skippedNotes}`);
    this.log(`Notes with errors: ${this.stats.errorNotes}`);
    this.log(`Total chunks created: ${this.stats.totalChunks}`);
    this.log(`Duration: ${durationSec} seconds`);
    
    if (this.stats.errorNotes > 0) {
      this.log('⚠️  Some notes had errors during processing');
    } else if (this.stats.chunkedNotes > 0) {
      this.log('✅ Migration completed successfully');
    } else {
      this.log('ℹ️  No notes required chunking');
    }
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--batch-size':
        if (i + 1 < args.length) {
          options.batchSize = parseInt(args[i + 1]);
          i++; // Skip next argument
        }
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
        console.log(`
Usage: node scripts/migrate-notes-chunking.js [options]

Options:
  --dry-run       Show what would be done without making changes
  --batch-size N  Number of notes to process at once (default: ${DEFAULT_BATCH_SIZE})
  --verbose       Show detailed progress information
  --help          Show this help message

Environment variables:
  POSTGRES_HOST     Database host (default: vectordb)
  POSTGRES_PORT     Database port (default: 5432)
  POSTGRES_DB       Database name (default: mydatabase)
  POSTGRES_USER     Database user (default: myuser)
  POSTGRES_PASSWORD Database password (default: mypassword)
  OPENAI_API_KEY    OpenAI API key for embeddings (required)
        `);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

// Main execution
async function main() {
  try {
    const options = parseArgs();
    const migration = new NoteMigration(options);
    await migration.run();
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = NoteMigration;