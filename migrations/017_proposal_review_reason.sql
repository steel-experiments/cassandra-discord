-- Preserve a bounded reviewer-facing recommendation reason separately from the
-- host-owned, content-free routing reason shown by proposal inventory commands.
ALTER TABLE proposals ADD COLUMN review_reason TEXT;
