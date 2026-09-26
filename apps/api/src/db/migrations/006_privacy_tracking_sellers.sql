-- Section 8: masked communication. Section 9: live location & ETA. Section 10: seller registry with graduated trust.

-- ================================================================ Section 8
-- Parties see the masked body; the original is kept (admin-only) as dispute evidence.
ALTER TABLE messages ADD COLUMN original_body TEXT;
UPDATE messages SET original_body = body WHERE original_body IS NULL;

-- ================================================================ Section 9
-- Latest en-route position per job, posted by the technician app. Only kept while en route.
CREATE TABLE job_tracking (
  job_id        UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES users(id),
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  heading       DOUBLE PRECISION,
  speed_mps     DOUBLE PRECISION,
  accuracy_m    DOUBLE PRECISION,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- In-app location disclosure accepted before the OS permission prompt (store requirements).
ALTER TABLE users ADD COLUMN location_disclosure_accepted_at TIMESTAMPTZ;

-- ================================================================ Section 10: graduated-trust seller registry
CREATE TYPE seller_status AS ENUM ('unlisted', 'provisional', 'verified', 'flagged', 'removed', 'merged');
ALTER TABLE spare_parts_sellers
  ADD COLUMN status          seller_status,
  ADD COLUMN email           TEXT,
  ADD COLUMN category_ids    INT[] NOT NULL DEFAULT '{}',          -- service categories they supply parts for
  ADD COLUMN clean_approvals INT NOT NULL DEFAULT 0,               -- price challenges resolved in favour of their evidence
  ADD COLUMN created_via     TEXT NOT NULL DEFAULT 'admin' CHECK (created_via IN ('admin', 'evidence')),
  ADD COLUMN created_by      UUID REFERENCES users(id),
  ADD COLUMN merged_into     UUID REFERENCES spare_parts_sellers(id),
  ADD COLUMN flag_reason     TEXT;
UPDATE spare_parts_sellers SET status = CASE WHEN is_verified THEN 'verified'::seller_status ELSE 'unlisted'::seller_status END;
ALTER TABLE spare_parts_sellers ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'verified';
DROP INDEX spare_parts_sellers_verified_idx;
ALTER TABLE spare_parts_sellers DROP COLUMN is_verified;
ALTER TABLE spare_parts_sellers ADD CONSTRAINT spare_parts_sellers_merge CHECK ((status = 'merged') = (merged_into IS NOT NULL));
CREATE INDEX spare_parts_sellers_status_idx ON spare_parts_sellers (status, name);

-- Evidence citing an unlisted seller goes to admin review before the technician is asked.
ALTER TABLE price_challenges ADD COLUMN evidence_review_note TEXT;
DROP INDEX price_challenges_one_pending;
CREATE UNIQUE INDEX price_challenges_one_open ON price_challenges (quote_id) WHERE status IN ('pending', 'pending_review');
