-- 026_direct_answer_job_index: index the job reference on direct-answer requests.
--
-- direct_answer_requests.job_id REFERENCES jobs(id) ON DELETE SET NULL. The
-- maintenance job prunes terminal job rows (Section 10), and every deleted row
-- makes SQLite look up its referencing requests to null them. Without this
-- index each lookup scans the whole direct_answer_requests table, so one
-- 1,000-row prune batch became 1,000 table scans.

CREATE INDEX IF NOT EXISTS direct_answer_requests_job_idx
  ON direct_answer_requests(job_id);
