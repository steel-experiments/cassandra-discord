-- 032_proposal_review_message_index: index proposals by their review-card
-- Discord message id for card-to-proposal resolution in direct answers.

CREATE INDEX IF NOT EXISTS proposals_review_message_idx
  ON proposals (review_message_id)
  WHERE review_message_id IS NOT NULL;
