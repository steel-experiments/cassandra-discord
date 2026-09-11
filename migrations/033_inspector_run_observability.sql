ALTER TABLE agent_runs
  ADD COLUMN model_turns_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(model_turns_json) AND json_type(model_turns_json) = 'array');

ALTER TABLE proposals
  ADD COLUMN policy_decision_json TEXT
  CHECK (
    policy_decision_json IS NULL
    OR (json_valid(policy_decision_json) AND json_type(policy_decision_json) = 'object')
  );
