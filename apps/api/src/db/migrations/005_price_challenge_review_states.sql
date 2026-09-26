-- New enum values must be committed before they can be used (e.g. in an index predicate),
-- so they get their own migration ahead of 006.
-- Section 10: evidence citing an unlisted seller goes to admin review before the technician is asked.
ALTER TYPE price_challenge_status ADD VALUE IF NOT EXISTS 'pending_review' BEFORE 'pending';
ALTER TYPE price_challenge_status ADD VALUE IF NOT EXISTS 'evidence_rejected';
