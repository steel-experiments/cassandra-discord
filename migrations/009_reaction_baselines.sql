-- 009_reaction_baselines: combine REST snapshots with ordered live changes.

ALTER TABLE reaction_counts ADD COLUMN baseline_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reaction_counts ADD COLUMN baseline_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reactions ADD COLUMN present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1));
ALTER TABLE reactions ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reactions ADD COLUMN delta INTEGER NOT NULL DEFAULT 1 CHECK (delta BETWEEN -1 AND 1);

UPDATE reaction_counts
   SET baseline_count = count,
       baseline_at_ms = updated_at_ms;

UPDATE reactions SET updated_at_ms = created_at_ms WHERE updated_at_ms = 0;
