-- 038_proactive_attention: proactive attention subjects, material human
-- revisions, source-linked evidence digests, and one proposal claim per
-- revision (Section 12.7). Applying this file confers no attention authority;
-- the startup cutover marks legacy surfaced evidence as consumed instead.

CREATE TABLE attention_subjects (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  registration_state TEXT NOT NULL
    CHECK (registration_state IN ('pending', 'complete')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX attention_subjects_guild_idx
  ON attention_subjects(guild_id, created_at_ms);

CREATE TABLE attention_subject_members (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  subject_id TEXT NOT NULL REFERENCES attention_subjects(id),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX attention_subject_members_subject_idx
  ON attention_subject_members(subject_id, memory_id);

CREATE TABLE attention_revisions (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES attention_subjects(id),
  revision_key TEXT NOT NULL CHECK (length(revision_key) > 0),
  human_event_at_ms INTEGER NOT NULL,
  explicit_deadline_at_ms INTEGER,
  deadline_timezone TEXT,
  deadline_parser_version TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('current', 'superseded', 'invalidated', 'legacy_consumed')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (subject_id, revision_key)
) STRICT;

CREATE INDEX attention_revisions_subject_idx
  ON attention_revisions(subject_id, human_event_at_ms, id);

CREATE TABLE attention_revision_evidence (
  revision_id TEXT NOT NULL REFERENCES attention_revisions(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  role TEXT NOT NULL
    CHECK (role IN ('material_trigger', 'explicit_deadline')),
  source_content_digest TEXT NOT NULL CHECK (length(source_content_digest) > 0),
  quote_start INTEGER NOT NULL CHECK (quote_start >= 0),
  quote_end INTEGER NOT NULL CHECK (quote_end >= quote_start),
  PRIMARY KEY (revision_id, message_id, role)
) STRICT;

CREATE INDEX attention_revision_evidence_message_idx
  ON attention_revision_evidence(message_id);

CREATE TABLE proposal_attention_claims (
  revision_id TEXT PRIMARY KEY REFERENCES attention_revisions(id),
  proposal_id TEXT UNIQUE REFERENCES proposals(id) ON DELETE SET NULL,
  consumed_at_ms INTEGER NOT NULL,
  eligible_from_ms INTEGER NOT NULL,
  eligible_until_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX proposal_attention_claims_proposal_idx
  ON proposal_attention_claims(proposal_id)
  WHERE proposal_id IS NOT NULL;
