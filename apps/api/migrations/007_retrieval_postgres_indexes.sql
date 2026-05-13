-- Postgre/pgvector retrieval indexes.
-- Runtime retrieval uses documents + chunks only; data/raw is ingestion input, not a runtime source.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS documents_source_source_id_idx
  ON documents (source, source_id);

CREATE INDEX IF NOT EXISTS chunks_article_no_idx
  ON chunks ((metadata->>'articleNo'));

CREATE INDEX IF NOT EXISTS chunks_law_id_idx
  ON chunks ((COALESCE(NULLIF(metadata->>'lawId', ''), metadata->>'sourceId')));

CREATE INDEX IF NOT EXISTS chunks_text_fts_simple_idx
  ON chunks USING GIN (to_tsvector('simple', COALESCE(text, '')));

CREATE INDEX IF NOT EXISTS documents_title_trgm_idx
  ON documents USING GIN (title gin_trgm_ops);
