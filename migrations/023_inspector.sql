-- 023_inspector: read-only admin web surface (Section 32.6).
--
-- inspector_tokens mirrors the mcp_tokens credential lifecycle (hash-only
-- storage, expiry, revocation, last-used tracking) for the inspector HTML
-- surface. It is a separate table on purpose: an MCP token must never
-- authenticate the inspector and an inspector token must never authenticate the
-- MCP endpoint, so neither path shares a lookup with the other. Unlike
-- mcp_tokens there are no scope columns -- the inspector grant is host-computed
-- per request and equals the secure review grant (Section 32.6), so a token
-- carries identity and lifecycle only.

CREATE TABLE IF NOT EXISTS inspector_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  last_used_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS inspector_tokens_created_idx
  ON inspector_tokens(created_at_ms);
