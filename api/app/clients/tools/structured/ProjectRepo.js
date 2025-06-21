const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');

// PostgreSQL client
const { Pool } = require('pg');

// For embeddings - using same approach as RAG API
const axios = require('axios');

class ProjectRepo extends Tool {
  name = 'project_memory';
  description_for_model = 'Allows the assistant to manage project-specific memory across sessions. This should be used for research, projects, LLM notes to self, and so on. This is separate from memories about the user. Actions: create_project, list_projects, add_note, search_notes, delete_note. Use add_note to store new context, search_notes to retrieve relevant information, and delete_note to remove outdated entries.';
  description =
    'Store and retrieve project-specific knowledge snippets for long-running research. ' +
    'Actions: create_project, list_projects, add_note, search_notes, delete_note. ' +
    'Supports keyword, semantic, and hybrid search across project notes. ' +
    'Perfect for maintaining context across multiple chat sessions.';

  schema = z.object({
    action: z.enum(['create_project', 'list_projects', 'add_note', 'search_notes', 'delete_note']),
    project_name: z.string().optional(),
    project_description: z.string().optional(),
    project_tags: z.array(z.string()).optional(),
    project_id: z.string().optional(),
    note_title: z.string().optional(),
    note_content: z.string().optional(),
    note_source_url: z.string().optional(),
    note_tags: z.array(z.string()).optional(),
    note_id: z.string().optional(),
    search_query: z.string().optional(),
    search_mode: z.enum(['keyword', 'semantic', 'hybrid']).optional(),
    limit: z.number().min(1).max(100).optional(),
    tag_filter: z.array(z.string()).optional(),
  });

  constructor(fields = {}) {
    super();
    this.userId = null; // Will be set from request context
    this.pool = null;
    // store promise so callers can await readiness before executing queries
    this.ready = this.initializeDatabase();
  }

  async initializeDatabase() {
    try {
      this.pool = new Pool({
        host: process.env.PG_HOST || 'vectordb',
        port: process.env.PG_PORT || 5432,
        database: process.env.PG_DB || 'mydatabase',
        user: process.env.PG_USER || 'myuser',
        password: process.env.PG_PASSWORD || 'mypassword',
      });

      // Test connection and create tables if needed
      await this.ensureTables();
    } catch (error) {
      logger.error('Failed to initialize ProjectRepo database:', error);
    }
  }

  async ensureTables() {
    const client = await this.pool.connect();
    try {
      // Enable pgvector extension
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      // Enable pgcrypto for gen_random_uuid()
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

      // Create projects table
      await client.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          tags TEXT[] DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create notes table
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_notes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source_url TEXT,
          tags TEXT[] DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create note_vectors table
      await client.query(`
        CREATE TABLE IF NOT EXISTS note_vectors (
          note_id UUID PRIMARY KEY REFERENCES project_notes(id) ON DELETE CASCADE,
          embedding vector(1536)
        )
      `);

      // Create indexes
      await client.query('CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_projects_tags ON projects USING GIN(tags)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_notes_project_id ON project_notes(project_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_notes_tags ON project_notes USING GIN(tags)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_notes_content_fulltext ON project_notes USING GIN(to_tsvector(\'english\', content))');
      await client.query('CREATE INDEX IF NOT EXISTS idx_note_vectors_embedding ON note_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)');

    } finally {
      client.release();
    }
  }

  async generateEmbedding(text) {
    try {
      // Try to use the same embedding service as the RAG API
      if (process.env.RAG_API_URL) {
        const response = await axios.post(`${process.env.RAG_API_URL}/embed-text`, {
          text: text,
        });
        return response.data.embedding;
      }

      // Fallback to OpenAI if RAG API not available
      if (process.env.OPENAI_API_KEY) {
        const response = await axios.post('https://api.openai.com/v1/embeddings', {
          input: text,
          model: 'text-embedding-3-small',
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        });
        return response.data.data[0].embedding;
      }

      throw new Error('No embedding service available');
    } catch (error) {
      logger.error('Failed to generate embedding:', error);
      return null;
    }
  }

  setUserId(userId) {
    this.userId = userId;
  }

  async createProject(name, description = '', tags = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'INSERT INTO projects (user_id, name, description, tags) VALUES ($1, $2, $3, $4) RETURNING *',
        [this.userId, name, description, tags]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async listProjects(tagFilter = null, limit = 50) {
    const client = await this.pool.connect();
    try {
      let query = 'SELECT * FROM projects WHERE user_id = $1';
      let params = [this.userId];

      if (tagFilter && tagFilter.length > 0) {
        query += ' AND tags && $2';
        params.push(tagFilter);
      }

      query += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1);
      params.push(limit);

      const result = await client.query(query, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async addNote(projectId, title, content, sourceUrl = null, tags = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Verify project belongs to user
      const projectCheck = await client.query(
        'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
        [projectId, this.userId]
      );

      if (projectCheck.rows.length === 0) {
        throw new Error('Project not found or access denied');
      }

      // Insert note
      const noteResult = await client.query(
        'INSERT INTO project_notes (project_id, title, content, source_url, tags) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [projectId, title, content, sourceUrl, tags]
      );

      const note = noteResult.rows[0];

      // Generate and store embedding
      const embedding = await this.generateEmbedding(`${title}\n\n${content}`);
      if (embedding) {
        // Convert JS array to pgvector literal '[v1,v2,...]'
        const vectorLiteral = `[${embedding.join(',')}]`;
        await client.query(
          'INSERT INTO note_vectors (note_id, embedding) VALUES ($1, $2::vector)',
          [note.id, vectorLiteral]
        );
      }

      // Update project timestamp
      await client.query(
        'UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [projectId]
      );

      await client.query('COMMIT');
      return note;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async searchNotes(params) {
    const {
      searchQuery,
      searchMode = 'hybrid',
      projectIds = null,
      tagFilter = null,
      limit = 20,
    } = params;

    const client = await this.pool.connect();
    try {
      // Build join and where conditions separately to avoid duplicate aliases
      const joinProjects = 'JOIN projects p ON n.project_id = p.id';
      let whereConditions = 'WHERE p.user_id = $1';
      let queryParams = [this.userId];
      let paramCount = 1;

      // Add project filter
      if (projectIds && projectIds.length > 0) {
        paramCount++;
        whereConditions += ` AND n.project_id = ANY($${paramCount})`;
        queryParams.push(projectIds);
      }

      // Add tag filter
      if (tagFilter && tagFilter.length > 0) {
        paramCount++;
        whereConditions += ` AND n.tags && $${paramCount}`;
        queryParams.push(tagFilter);
      }

      if (searchMode === 'keyword') {
        paramCount++;
        const query = `
          SELECT n.*, p.name as project_name, ts_rank(to_tsvector('english', n.content), plainto_tsquery('english', $${paramCount})) as score
          FROM project_notes n
          ${joinProjects}
          ${whereConditions}
          AND to_tsvector('english', n.content) @@ plainto_tsquery('english', $${paramCount})
          ORDER BY score DESC
          LIMIT $${paramCount + 1}
        `;
        queryParams.push(searchQuery, limit);
        const result = await client.query(query, queryParams);
        return result.rows;

      } else if (searchMode === 'semantic') {
        const queryEmbedding = await this.generateEmbedding(searchQuery);
        if (!queryEmbedding) {
          throw new Error('Failed to generate query embedding');
        }

        paramCount++;
        const query = `
          SELECT n.*, p.name as project_name, (1 - (v.embedding <=> $${paramCount}::vector)) as score
          FROM project_notes n
          JOIN note_vectors v ON n.id = v.note_id
          ${joinProjects}
          ${whereConditions}
          ORDER BY v.embedding <=> $${paramCount}::vector
          LIMIT $${paramCount + 1}
        `;
        queryParams.push(JSON.stringify(queryEmbedding), limit);
        const result = await client.query(query, queryParams);
        return result.rows;

      } else if (searchMode === 'hybrid') {
        const queryEmbedding = await this.generateEmbedding(searchQuery);
        if (!queryEmbedding) {
          // Fallback to keyword search
          return this.searchNotes({ ...params, searchMode: 'keyword' });
        }

        paramCount++;
        const textParam = paramCount;
        paramCount++;
        const vectorParam = paramCount;
        paramCount++;
        const limitParam = paramCount;

        const query = `
          WITH keyword_scores AS (
            SELECT n.id, ts_rank(to_tsvector('english', n.content), plainto_tsquery('english', $${textParam})) as keyword_score
            FROM project_notes n
            ${joinProjects}
            ${whereConditions}
            AND to_tsvector('english', n.content) @@ plainto_tsquery('english', $${textParam})
          ),
          semantic_scores AS (
            SELECT n.id, (1 - (v.embedding <=> $${vectorParam}::vector)) as semantic_score
            FROM project_notes n
            JOIN note_vectors v ON n.id = v.note_id
            ${joinProjects}
            ${whereConditions}
          )
          SELECT n.*, p.name as project_name,
                 COALESCE(k.keyword_score * 0.3, 0) + COALESCE(s.semantic_score * 0.7, 0) as score
          FROM project_notes n
          ${joinProjects}
          ${whereConditions}
          LEFT JOIN keyword_scores k ON n.id = k.id
          LEFT JOIN semantic_scores s ON n.id = s.id
          WHERE (k.keyword_score IS NOT NULL OR s.semantic_score IS NOT NULL)
          ORDER BY score DESC
          LIMIT $${limitParam}
        `;
        queryParams.push(searchQuery, JSON.stringify(queryEmbedding), limit);
        const result = await client.query(query, queryParams);
        return result.rows;
      }

    } finally {
      client.release();
    }
  }

  async deleteNote(noteId) {
    const client = await this.pool.connect();
    try {
      // Verify note belongs to user (through project ownership)
      const result = await client.query(`
        DELETE FROM project_notes n
        USING projects p
        WHERE n.project_id = p.id
        AND p.user_id = $1
        AND n.id = $2
        RETURNING n.*
      `, [this.userId, noteId]);

      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async _call(args) {
    try {
      if (!this.userId) {
        return JSON.stringify({ error: 'User context not available' });
      }

      // Ensure database initialization complete
      await this.ready;

      const { action } = args;

      switch (action) {
        case 'create_project': {
          const { project_name, project_description = '', project_tags = [] } = args;
          if (!project_name) {
            return JSON.stringify({ error: 'project_name is required' });
          }
          const project = await this.createProject(project_name, project_description, project_tags);
          return JSON.stringify({
            success: true,
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              tags: project.tags,
              created_at: project.created_at
            }
          });
        }

        case 'list_projects': {
          const { tag_filter, limit = 50 } = args;
          const projects = await this.listProjects(tag_filter, limit);
          return JSON.stringify({
            success: true,
            projects: projects.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              tags: p.tags,
              created_at: p.created_at,
              updated_at: p.updated_at
            }))
          });
        }

        case 'add_note': {
          const { project_id, note_title, note_content, note_source_url, note_tags = [] } = args;
          if (!project_id || !note_title || !note_content) {
            return JSON.stringify({ error: 'project_id, note_title, and note_content are required' });
          }
          const note = await this.addNote(project_id, note_title, note_content, note_source_url, note_tags);
          return JSON.stringify({
            success: true,
            note: {
              id: note.id,
              project_id: note.project_id,
              title: note.title,
              content: note.content,
              source_url: note.source_url,
              tags: note.tags,
              created_at: note.created_at
            }
          });
        }

        case 'search_notes': {
          const { search_query, search_mode = 'hybrid', project_id, tag_filter, limit = 20 } = args;
          if (!search_query) {
            return JSON.stringify({ error: 'search_query is required' });
          }

          const projectIds = project_id ? [project_id] : null;
          const notes = await this.searchNotes({
            searchQuery: search_query,
            searchMode: search_mode,
            projectIds,
            tagFilter: tag_filter,
            limit
          });

          return JSON.stringify({
            success: true,
            notes: notes.map(n => ({
              id: n.id,
              project_id: n.project_id,
              project_name: n.project_name,
              title: n.title,
              content: n.content,
              source_url: n.source_url,
              tags: n.tags,
              score: n.score,
              created_at: n.created_at
            })),
            search_mode: search_mode,
            query: search_query
          });
        }

        case 'delete_note': {
          const { note_id } = args;
          if (!note_id) {
            return JSON.stringify({ error: 'note_id is required' });
          }
          const deletedNote = await this.deleteNote(note_id);
          if (!deletedNote) {
            return JSON.stringify({ error: 'Note not found or access denied' });
          }
          return JSON.stringify({
            success: true,
            message: 'Note deleted successfully',
            deleted_note_id: note_id
          });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }

    } catch (error) {
      logger.error('ProjectRepo tool error:', error);
      return JSON.stringify({ error: error.message });
    }
  }
}

module.exports = ProjectRepo;