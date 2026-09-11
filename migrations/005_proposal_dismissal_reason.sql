-- 005: persist the optional dismissal reason on the proposal row (Section 25,
-- task T073). Section 25 states "Dismissal stores an optional reason for
-- evaluation." The actor and timestamp already live in reviewed_by_user_id /
-- reviewed_at_ms; this column records the admin's bounded, content-free reason
-- alongside the proposal so outcome + reason are queryable in one place for
-- evaluation metrics. NULL means the proposal was not dismissed or carried no
-- reason. No status or constraint changes.
ALTER TABLE proposals ADD COLUMN dismissal_reason TEXT;
