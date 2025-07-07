# Note Chunking Migration Scripts

This directory contains scripts to migrate existing notes in the Collections tool to use the new chunking functionality.

## Overview

The chunking system automatically breaks large notes (>2000 characters) into smaller, searchable chunks with embeddings. This improves search accuracy and provides relevant snippets in search results.

## Files

- **`migrate-notes-chunking.js`** - Main migration script
- **`test-migration.js`** - Test script to verify migration works correctly
- **`README-chunking-migration.md`** - This documentation

## Prerequisites

1. **Environment Variables**: Ensure the following are set:
   ```bash
   export POSTGRES_HOST=vectordb
   export POSTGRES_PORT=5432
   export POSTGRES_DB=mydatabase
   export POSTGRES_USER=myuser
   export POSTGRES_PASSWORD=mypassword
   export OPENAI_API_KEY=your_openai_api_key
   ```

2. **Database Schema**: The Collections tool will automatically add the required tables and columns when first run.

## Usage

### 1. Test the Migration (Recommended First Step)

Run the test script to verify everything works:

```bash
cd /workspaces
node scripts/test-migration.js
```

This will:
- Create sample notes of various sizes
- Run a dry-run migration
- Execute the actual migration
- Verify results
- Clean up test data

### 2. Dry Run Migration

Before running the actual migration, do a dry run to see what would happen:

```bash
node scripts/migrate-notes-chunking.js --dry-run --verbose
```

This shows you:
- How many notes would be processed
- Which notes would be chunked
- Estimated number of chunks that would be created
- No actual changes are made

### 3. Run the Migration

Execute the migration with appropriate batch size:

```bash
# Basic migration
node scripts/migrate-notes-chunking.js

# With custom batch size and verbose output
node scripts/migrate-notes-chunking.js --batch-size 20 --verbose

# For large datasets, use smaller batches to avoid memory issues
node scripts/migrate-notes-chunking.js --batch-size 5 --verbose
```

### Command Line Options

- **`--dry-run`**: Show what would be done without making changes
- **`--batch-size N`**: Process N notes at a time (default: 10)
- **`--verbose`**: Show detailed progress information
- **`--help`**: Display help message

## Migration Process

The migration script:

1. **Finds unprocessed notes**: Looks for notes where `is_chunked = false` or `is_chunked IS NULL`
2. **Evaluates each note**: Determines if the note is large enough to benefit from chunking (>2000 characters)
3. **Creates chunks**: Breaks large notes into ~1000 token chunks with 100 token overlap
4. **Generates embeddings**: Creates vector embeddings for each chunk using OpenAI's text-embedding-3-small model
5. **Updates flags**: Sets `is_chunked = true` for processed notes
6. **Provides progress**: Shows detailed progress and statistics

## Database Changes

The migration adds:

### New Column
- `notes.is_chunked` (BOOLEAN) - Tracks whether a note has been processed for chunking

### New Tables
- `note_chunks` - Stores individual chunks of large notes
- `note_chunk_vectors` - Stores vector embeddings for each chunk

## Performance Considerations

- **Batch Processing**: The script processes notes in batches to manage memory usage
- **Rate Limiting**: OpenAI API calls are made sequentially to respect rate limits
- **Progress Tracking**: The `is_chunked` flag allows resuming interrupted migrations
- **Transaction Safety**: Each note is processed in its own transaction

## Troubleshooting

### Common Issues

1. **OpenAI API Key Missing**:
   ```
   Error: No OpenAI API key configured for embeddings
   ```
   Solution: Set the `OPENAI_API_KEY` environment variable

2. **Database Connection Issues**:
   ```
   Error: Connection failed
   ```
   Solution: Verify PostgreSQL environment variables and that the database is running

3. **Out of Memory**:
   ```
   Error: JavaScript heap out of memory
   ```
   Solution: Use a smaller `--batch-size` (try 5 or fewer)

4. **Rate Limiting**:
   ```
   Error: Too many requests
   ```
   Solution: The script includes automatic retry logic, but you may need to wait and retry

### Monitoring Progress

The script provides detailed statistics:
- Total notes found
- Notes processed vs. remaining
- Notes chunked vs. skipped
- Total chunks created
- Processing time

### Resuming Interrupted Migration

If the migration is interrupted, simply run it again. The script will:
- Skip notes that are already chunked (`is_chunked = true`)
- Continue processing remaining notes
- Provide updated statistics

## Verification

After migration, you can verify the results:

```sql
-- Check migration status
SELECT 
  is_chunked,
  COUNT(*) as note_count,
  AVG(LENGTH(content)) as avg_content_length
FROM notes 
GROUP BY is_chunked;

-- Check chunks created
SELECT 
  COUNT(DISTINCT nc.note_id) as notes_with_chunks,
  COUNT(*) as total_chunks,
  AVG(nc.token_count) as avg_chunk_tokens
FROM note_chunks nc;

-- Check embeddings created
SELECT COUNT(*) as chunk_embeddings_count 
FROM note_chunk_vectors;
```

## Rollback

If you need to rollback the migration:

```sql
-- Remove all chunks and embeddings
DELETE FROM note_chunks;

-- Reset chunking flags
UPDATE notes SET is_chunked = FALSE;
```

Note: This will not restore the original `note_vectors` entries if they were replaced during the migration.

## Support

If you encounter issues:
1. Check the logs for detailed error messages
2. Verify environment variables are set correctly
3. Ensure the database has the required tables and permissions
4. Try running with `--verbose` for more diagnostic information