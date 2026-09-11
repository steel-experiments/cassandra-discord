-- Durable per-call cost attribution for deep recaps.
--
-- `run_id` deliberately is not a foreign key: the recap worker reserves the
-- association before executeAgentRun inserts its agent_runs row. This closes
-- the crash window between a billable provider call and caller-side accounting.
CREATE TABLE deep_recap_model_calls (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES deep_recap_requests(id) ON DELETE RESTRICT,
  run_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('chunk','synthesis')),
  chunk_ordinal INTEGER CHECK (chunk_ordinal IS NULL OR chunk_ordinal >= 0),
  started_at_ms INTEGER NOT NULL,
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  accounted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (phase='chunk' AND chunk_ordinal IS NOT NULL)
    OR (phase='synthesis' AND chunk_ordinal IS NULL)
  ),
  CHECK ((cost_usd IS NULL) = (accounted_at_ms IS NULL))
) STRICT;

CREATE UNIQUE INDEX deep_recap_model_calls_run_idx
  ON deep_recap_model_calls(run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX deep_recap_model_calls_request_idx
  ON deep_recap_model_calls(request_id, phase, chunk_ordinal, started_at_ms);

CREATE INDEX deep_recap_model_calls_day_idx
  ON deep_recap_model_calls(started_at_ms);

-- Preserve the provider spend recorded by migration 018. Legacy synthesis
-- rows did not retain a run id, but remain timestamped accounting entries.
INSERT INTO deep_recap_model_calls (
  id,request_id,run_id,phase,chunk_ordinal,started_at_ms,cost_usd,
  accounted_at_ms,created_at_ms,updated_at_ms
)
SELECT 'legacy:chunk:' || c.request_id || ':' || c.ordinal,
       c.request_id,c.run_id,'chunk',c.ordinal,
       COALESCE(ar.started_at_ms,c.updated_at_ms),c.cost_usd,
       c.updated_at_ms,c.created_at_ms,c.updated_at_ms
  FROM deep_recap_chunks c
  LEFT JOIN agent_runs ar ON ar.id=c.run_id
 WHERE c.cost_usd>0;

INSERT INTO deep_recap_model_calls (
  id,request_id,run_id,phase,chunk_ordinal,started_at_ms,cost_usd,
  accounted_at_ms,created_at_ms,updated_at_ms
)
SELECT 'legacy:synthesis:' || r.id,
       r.id,NULL,'synthesis',NULL,
       COALESCE(r.completed_at_ms,r.updated_at_ms),r.synthesis_cost_usd,
       r.updated_at_ms,r.created_at_ms,r.updated_at_ms
  FROM deep_recap_requests r
 WHERE r.synthesis_cost_usd>0;
