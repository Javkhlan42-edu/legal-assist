-- ────────────────────────────────────────────────────────────
-- Migration: Create chunks table for BM25 keyword search
-- ────────────────────────────────────────────────────────────

-- Create chunks table for document chunking and keyword indexing
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chunks_document_id_fk FOREIGN KEY (document_id)
    REFERENCES documents(id) ON DELETE CASCADE
);

-- Create indices for efficient searching
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_created_at_idx ON chunks(created_at);

-- ── Full-Text Search Indices ────────────────────────────────

-- Create GIN index for full-text search (PostgreSQL native FTS)
-- This enables fast ts_rank() scoring for BM25-like ranking
CREATE INDEX IF NOT EXISTS chunks_ftsidx ON chunks 
  USING GIN(to_tsvector('simple', text));

-- Also create a trigram index for Mongolian/partial matching (pg_trgm extension)
-- First ensure the extension is available
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS chunks_trgm_idx ON chunks 
  USING GIN(text gin_trgm_ops);

-- Update the update_at timestamp on row updates
CREATE OR REPLACE FUNCTION update_chunks_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_updated_at_trigger ON chunks;
CREATE TRIGGER chunks_updated_at_trigger
  BEFORE UPDATE ON chunks
  FOR EACH ROW
  EXECUTE FUNCTION update_chunks_updated_at();

-- ────────────────────────────────────────────────────────────
-- Add vector_id column (reference to ChromaDB vectors)
-- ────────────────────────────────────────────────────────────

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS vector_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS chunks_vector_id_idx ON chunks(vector_id);

-- documents.source is managed by 001_create_documents_table.sql
