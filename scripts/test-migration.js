#!/usr/bin/env node

/**
 * Test script for the note chunking migration
 * Creates sample notes and tests the migration process
 */

const { Pool } = require('pg');
const NoteMigration = require('./migrate-notes-chunking');

class MigrationTest {
  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST || 'vectordb',
      port: Number(process.env.POSTGRES_PORT) || 5432,
      database: process.env.POSTGRES_DB || 'mydatabase',
      user: process.env.POSTGRES_USER || 'myuser',
      password: process.env.POSTGRES_PASSWORD || 'mypassword',
    });

    this.testCollectionId = null;
    this.createdNoteIds = [];
  }

  async createTestCollection(client) {
    const result = await client.query(
      `INSERT INTO collections (user_id, name, description) 
       VALUES ($1, $2, $3) RETURNING id`,
      ['test-user', 'Migration Test Collection', 'Collection for testing note chunking migration']
    );
    
    this.testCollectionId = result.rows[0].id;
    console.log(`Created test collection: ${this.testCollectionId}`);
  }

  async createTestNote(client, title, content, shouldChunk = false) {
    const result = await client.query(
      `INSERT INTO notes (collection_id, title, content, is_chunked) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [this.testCollectionId, title, content, false] // Always start with is_chunked = false
    );
    
    const noteId = result.rows[0].id;
    this.createdNoteIds.push(noteId);
    
    console.log(`Created test note: ${noteId} (${content.length} chars, should chunk: ${shouldChunk})`);
    return noteId;
  }

  async createTestData() {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await this.createTestCollection(client);
      
      // Small note - should not be chunked
      await this.createTestNote(
        client,
        'Small Note',
        'This is a small note that should not be chunked because it is too short.',
        false
      );

      // Medium note - should not be chunked
      await this.createTestNote(
        client,
        'Medium Note',
        'This is a medium-sized note. '.repeat(50) + 'It should still not be chunked.',
        false
      );

      // Large note - should be chunked
      const largeContent = `This is a very long note that should definitely be chunked. `.repeat(100) +
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(50) +
        `Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. `.repeat(50) +
        `Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. `.repeat(50);
      
      await this.createTestNote(
        client,
        'Large Note for Chunking',
        largeContent,
        true
      );

      // Another large note
      const anotherLargeContent = `Technical documentation about machine learning algorithms. `.repeat(80) +
        `Neural networks are computational models inspired by biological neural networks. `.repeat(40) +
        `They consist of interconnected nodes that process information. `.repeat(60) +
        `Deep learning uses multiple layers to progressively extract features. `.repeat(50);
      
      await this.createTestNote(
        client,
        'Machine Learning Documentation',
        anotherLargeContent,
        true
      );

      await client.query('COMMIT');
      console.log('✅ Test data created successfully');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async checkResults() {
    const client = await this.pool.connect();
    
    try {
      console.log('\n=== CHECKING RESULTS ===');
      
      // Check notes
      const notesResult = await client.query(
        `SELECT id, title, LENGTH(content) as content_length, is_chunked 
         FROM notes WHERE id = ANY($1) ORDER BY content_length`,
        [this.createdNoteIds]
      );

      console.log('\nNotes status:');
      for (const note of notesResult.rows) {
        console.log(`- ${note.title}: ${note.content_length} chars, chunked: ${note.is_chunked}`);
      }

      // Check chunks
      const chunksResult = await client.query(
        `SELECT nc.note_id, n.title, COUNT(*) as chunk_count
         FROM note_chunks nc
         JOIN notes n ON nc.note_id = n.id
         WHERE nc.note_id = ANY($1)
         GROUP BY nc.note_id, n.title
         ORDER BY chunk_count DESC`,
        [this.createdNoteIds]
      );

      if (chunksResult.rows.length > 0) {
        console.log('\nChunks created:');
        for (const chunk of chunksResult.rows) {
          console.log(`- ${chunk.title}: ${chunk.chunk_count} chunks`);
        }
      } else {
        console.log('\nNo chunks found');
      }

      // Check embeddings
      const embeddingsResult = await client.query(
        `SELECT nc.note_id, n.title, COUNT(cv.*) as embedding_count
         FROM note_chunks nc
         JOIN notes n ON nc.note_id = n.id
         LEFT JOIN note_chunk_vectors cv ON nc.id = cv.chunk_id
         WHERE nc.note_id = ANY($1)
         GROUP BY nc.note_id, n.title
         ORDER BY embedding_count DESC`,
        [this.createdNoteIds]
      );

      if (embeddingsResult.rows.length > 0) {
        console.log('\nEmbeddings created:');
        for (const embedding of embeddingsResult.rows) {
          console.log(`- ${embedding.title}: ${embedding.embedding_count} embeddings`);
        }
      } else {
        console.log('\nNo embeddings found');
      }

    } finally {
      client.release();
    }
  }

  async cleanup() {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Delete test data
      if (this.testCollectionId) {
        await client.query('DELETE FROM collections WHERE id = $1', [this.testCollectionId]);
        console.log('🧹 Test data cleaned up');
      }
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error during cleanup:', error);
    } finally {
      client.release();
      await this.pool.end();
    }
  }

  async run() {
    try {
      console.log('🧪 Starting migration test...\n');
      
      // Create test data
      await this.createTestData();
      
      // Run migration in dry-run mode first
      console.log('\n🔍 Running migration in dry-run mode...');
      const dryRunMigration = new NoteMigration({ dryRun: true, verbose: true });
      await dryRunMigration.run();
      
      // Run actual migration
      console.log('\n🚀 Running actual migration...');
      const migration = new NoteMigration({ verbose: true });
      await migration.run();
      
      // Check results
      await this.checkResults();
      
      console.log('\n✅ Migration test completed successfully!');
      
    } catch (error) {
      console.error('❌ Migration test failed:', error);
      throw error;
    } finally {
      // Clean up
      await this.cleanup();
    }
  }
}

// Main execution
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable is required for testing');
    process.exit(1);
  }

  const test = new MigrationTest();
  await test.run();
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}

module.exports = MigrationTest;