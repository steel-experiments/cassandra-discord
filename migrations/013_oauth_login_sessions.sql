-- 013_oauth_login_sessions: pending MCP authorization requests (Section 32.5.2).
-- One row per in-flight sign-in, created when a client reaches /authorize and
-- consumed when the identity provider returns. Rows are short-lived and hold no
-- credential: the PKCE code challenge is a public value, and the row is deleted
-- once it is used or has expired.

CREATE TABLE IF NOT EXISTS oauth_login_sessions (
  -- Opaque handle passed to the identity provider as its `state` parameter and
  -- looked up on return. Single use.
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  -- Validated against the registered list before the row was written; stored so
  -- the eventual redirect cannot be influenced by the return leg.
  redirect_uri TEXT NOT NULL,
  -- The client's own `state`, returned verbatim. Absent when the client sent none.
  client_state TEXT,
  -- PKCE (RFC 7636). Only S256 is accepted, so no method column is needed.
  code_challenge TEXT NOT NULL,
  -- RFC 8707 resource indicator: which MCP endpoint the token is destined for.
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;

-- Expiry sweeps scan by deadline.
CREATE INDEX IF NOT EXISTS idx_oauth_login_sessions_expires
  ON oauth_login_sessions (expires_at_ms);
