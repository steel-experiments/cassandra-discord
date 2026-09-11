-- 014_oauth_authorization_codes: issued MCP authorization codes (Section 32.5.2).
-- One row per code handed back to a client after a person signed in with Discord.
-- Only the SHA-256 hash of the code is stored, so a stolen database row cannot be
-- redeemed. Rows outlive their single use on purpose: a second presentation of a
-- consumed code is evidence of interception, which cannot be detected once the
-- row is gone (OAuth 2.1 Section 4.1.3).

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  -- SHA-256 hex of the code. The plaintext exists only in the redirect that
  -- delivers it and in the client's memory; it is never written here.
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  -- Bound at issue. The token request must present the same value, so a code
  -- cannot be redeemed against a different redirect than it was issued for.
  redirect_uri TEXT NOT NULL,
  -- PKCE (RFC 7636). The verifier is checked against this at the token endpoint.
  code_challenge TEXT NOT NULL,
  -- RFC 8707 audience the eventual access token is for.
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  -- The Discord user who signed in. The subject of the token that follows.
  subject_user_id TEXT NOT NULL,
  -- The visibility grant resolved from that person's Discord roles, in the same
  -- shape mcp_tokens uses so retrieval has one grant model, not two.
  scope_type TEXT NOT NULL DEFAULT 'org'
    CHECK (scope_type IN ('org', 'org_plus_channels')),
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  -- Set the first time the code is redeemed. A later attempt finds it set and is
  -- refused as a replay.
  consumed_at_ms INTEGER
) STRICT;

-- Expiry sweeps scan by deadline.
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_expires
  ON oauth_authorization_codes (expires_at_ms);
