-- ────────────────────────────────────────────────────────────
-- Migration: Create conversations and messages tables
-- ────────────────────────────────────────────────────────────

-- Create conversations table to track user conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(512) NOT NULL,
  metadata JSONB DEFAULT '{}', -- e.g., { "language": "mn", "model": "gpt-4o-mini" }
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create messages table for conversation history
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}', -- e.g., { "confidence": 0.95, "sources": 3, "latencyMs": 1250 }
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT messages_conversation_id_fk FOREIGN KEY (conversation_id)
    REFERENCES conversations(id) ON DELETE CASCADE
);

-- Indices for efficient querying
CREATE INDEX IF NOT EXISTS conversations_created_at_idx ON conversations(created_at);
CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations(updated_at);
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages(role);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);

-- Composite index for common query pattern
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx 
  ON messages(conversation_id, created_at DESC);

-- Update trigger for conversations.updated_at
CREATE OR REPLACE FUNCTION update_conversations_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_updated_at_trigger ON conversations;
CREATE TRIGGER conversations_updated_at_trigger
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_conversations_updated_at();

-- Also update conversation.updated_at when new message is added
CREATE OR REPLACE FUNCTION update_conversation_on_message()
  RETURNS TRIGGER AS $$
  BEGIN
    UPDATE conversations SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.conversation_id;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_update_conversation_trigger ON messages;
CREATE TRIGGER messages_update_conversation_trigger
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_on_message();

-- Create audit_logs table for query auditing
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID,
  query TEXT,
  response_length INTEGER,
  sources_used INTEGER,
  latency_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_conversation_id_fk FOREIGN KEY (conversation_id)
    REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS audit_logs_conversation_id_idx ON audit_logs(conversation_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);

-- ────────────────────────────────────────────────────────────
-- Example: Retrieve conversation with all messages
-- ────────────────────────────────────────────────────────────
-- SELECT c.id, c.title, c.created_at, c.updated_at,
--        json_agg(
--          json_build_object(
--            'id', m.id,
--            'role', m.role,
--            'content', m.content,
--            'createdAt', m.created_at
--          ) ORDER BY m.created_at ASC
--        ) as messages
-- FROM conversations c
-- LEFT JOIN messages m ON c.id = m.conversation_id
-- WHERE c.id = $1
-- GROUP BY c.id, c.title, c.created_at, c.updated_at;
