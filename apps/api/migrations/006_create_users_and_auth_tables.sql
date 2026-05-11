-- Migration: Create users/auth tables and scope conversations to users

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name VARCHAR(120),
  avatar_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
  ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL CHECK (provider IN ('credentials', 'google')),
  provider_user_id TEXT NOT NULL,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auth_identities_provider_user_id_uniq UNIQUE (provider, provider_user_id),
  CONSTRAINT auth_identities_credentials_password_chk CHECK (
    (provider = 'credentials' AND password_hash IS NOT NULL) OR
    (provider <> 'credentials')
  )
);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities(user_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations(user_id);
CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations(user_id, updated_at DESC);

CREATE OR REPLACE FUNCTION update_generic_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at_trigger ON users;
CREATE TRIGGER users_updated_at_trigger
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_generic_updated_at();

DROP TRIGGER IF EXISTS auth_identities_updated_at_trigger ON auth_identities;
CREATE TRIGGER auth_identities_updated_at_trigger
  BEFORE UPDATE ON auth_identities
  FOR EACH ROW
  EXECUTE FUNCTION update_generic_updated_at();
