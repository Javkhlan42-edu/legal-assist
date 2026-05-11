-- ────────────────────────────────────────────────────────────
-- Migration: Create documents table for ingested legal documents
-- ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_source') THEN
    CREATE TYPE document_source AS ENUM ('shuukh', 'legalinfo', 'other');
  END IF;
END
$$;

-- Create documents table to track ingested documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source document_source NOT NULL,
  source_id VARCHAR(255) UNIQUE, -- External ID (caseId, lawId, etc.)
  title VARCHAR(1024) NOT NULL,
  url VARCHAR(1024),
  content_hash VARCHAR(64), -- SHA-256 hash to detect duplicates
  raw_html TEXT, -- Original HTML for re-parsing if needed
  processed_at TIMESTAMP,
  metadata JSONB DEFAULT '{}', -- e.g. { "court": "...", "date": "...", "articles": [...] }
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT documents_source_id_unique UNIQUE (source, source_id)
);

-- Indices for efficient querying
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents(source);
CREATE INDEX IF NOT EXISTS documents_source_id_idx ON documents(source_id);
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents(created_at);
CREATE INDEX IF NOT EXISTS documents_updated_at_idx ON documents(updated_at);
CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(content_hash);

-- Full-text search index on document title
CREATE INDEX IF NOT EXISTS documents_title_ftsidx ON documents 
  USING GIN(to_tsvector('simple', title));

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_documents_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_updated_at_trigger ON documents;
CREATE TRIGGER documents_updated_at_trigger
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION update_documents_updated_at();
