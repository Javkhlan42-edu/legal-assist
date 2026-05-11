-- ────────────────────────────────────────────────────────────
-- Migration: pgvector-first hybrid storage hardening
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keep legacy source column while introducing explicit source_type.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_type document_source;

UPDATE documents
SET source_type = source
WHERE source_type IS NULL;

ALTER TABLE documents
  ALTER COLUMN source_type SET DEFAULT 'other';

ALTER TABLE documents
  ALTER COLUMN source_type SET NOT NULL;

CREATE OR REPLACE FUNCTION sync_document_source_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type IS NULL AND NEW.source IS NOT NULL THEN
    NEW.source_type = NEW.source;
  ELSIF NEW.source IS NULL AND NEW.source_type IS NOT NULL THEN
    NEW.source = NEW.source_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_sync_source_trigger ON documents;
CREATE TRIGGER documents_sync_source_trigger
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION sync_document_source_columns();

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS crawl_status VARCHAR(32) DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS crawl_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS documents_url_unique_idx
  ON documents(url)
  WHERE url IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_source_type_idx ON documents(source_type);

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS char_start INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS char_end INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(128),
  ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
  ADD COLUMN IF NOT EXISTS vector_provider VARCHAR(32) DEFAULT 'pgvector';

-- Backfill core chunk metadata for existing rows.
UPDATE chunks
SET token_count = GREATEST(1, array_length(regexp_split_to_array(trim(text), E'\\s+'), 1))
WHERE token_count IS NULL OR token_count = 0;

UPDATE chunks
SET char_start = 0
WHERE char_start IS NULL;

UPDATE chunks
SET char_end = char_length(text)
WHERE char_end IS NULL OR char_end = 0;

CREATE UNIQUE INDEX IF NOT EXISTS chunks_document_chunk_unique_idx
  ON chunks(document_id, chunk_index);

CREATE UNIQUE INDEX IF NOT EXISTS chunks_document_hash_unique_idx
  ON chunks(document_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS crawl_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source document_source NOT NULL,
  url VARCHAR(1024) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('success', 'failed', 'retry', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  http_status INTEGER,
  error_message TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS crawl_logs_source_created_idx
  ON crawl_logs(source, created_at DESC);

CREATE INDEX IF NOT EXISTS crawl_logs_status_created_idx
  ON crawl_logs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source document_source NOT NULL,
  url VARCHAR(1024) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  error_message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS dead_letter_queue_source_created_idx
  ON dead_letter_queue(source, created_at DESC);

CREATE INDEX IF NOT EXISTS dead_letter_queue_stage_created_idx
  ON dead_letter_queue(stage, created_at DESC);
