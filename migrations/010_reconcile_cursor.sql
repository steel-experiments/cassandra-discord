-- 010_reconcile_cursor: resume bounded reconciliation walks after each batch.

ALTER TABLE sync_cursors ADD COLUMN reconcile_before_message_id TEXT;
