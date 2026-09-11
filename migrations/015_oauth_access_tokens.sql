-- 015_oauth_access_tokens: MCP tokens minted by a Discord sign-in (Section 32.5.2).
-- An OAuth access token is an mcp_tokens row like any other, so retrieval keeps one
-- grant model and one validation path rather than two. These columns record what an
-- admin-issued token has no need of: which person the token speaks for, and which
-- refresh chain it belongs to.

ALTER TABLE mcp_tokens ADD COLUMN subject_user_id TEXT;
ALTER TABLE mcp_tokens ADD COLUMN oauth_family_id TEXT;

-- Revoking a refresh chain revokes every access token in it, which is a lookup by
-- family.
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_oauth_family
  ON mcp_tokens (oauth_family_id) WHERE oauth_family_id IS NOT NULL;

-- Refresh tokens are separate from access tokens: they are presented to a
-- different endpoint, live far longer, and rotate on every use. Only the SHA-256
-- hash is stored, and a consumed row is kept so that a second presentation is
-- recognized as theft rather than as an unknown token (OAuth 2.1 Section 4.3.1).
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  -- All tokens descended from one sign-in share a family. Presenting a consumed
  -- refresh token revokes the whole family, because either the client or an
  -- attacker holds a copy and there is no way to tell which.
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'org'
    CHECK (scope_type IN ('org', 'org_plus_channels')),
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  -- Set when the token is exchanged. A later attempt finds it set and is treated
  -- as a replay.
  consumed_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires
  ON oauth_refresh_tokens (expires_at_ms);
