-- ────────────────────────────────────────────────────────────
-- Migration 005: chunks.embedding → vector(3072)
-- For OpenAI text-embedding-3-large at full native dimension.
--
-- After apply: re-run document ingest / embedding (old vectors cleared).
-- ────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;

UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL;

ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(3072);

-- HNSW on fp32 vector() is capped at 2000 dims in pgvector; use halfvec cast for 3072.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
