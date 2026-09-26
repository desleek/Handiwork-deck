-- Section 6: customer quote responses (labor-only rejections, evidence-backed price challenges
--            with escalation timeline, labor negotiation with technician counters).
-- Section 7: dual ratings, completion badge. Section 7a: performance-based labor rate adjustment.
-- Section 10 (placeholder): verified spare-parts seller registry used as price evidence.

-- ================================================================ verified seller registry
CREATE TABLE spare_parts_sellers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  registration_number TEXT,
  phone               TEXT,
  address             TEXT,
  city                TEXT,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,   -- linked advertiser account, if any
  is_verified         BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  verified_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX spare_parts_sellers_verified_idx ON spare_parts_sellers (is_verified, name);
CREATE TRIGGER spare_parts_sellers_touch BEFORE UPDATE ON spare_parts_sellers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TYPE file_kind ADD VALUE IF NOT EXISTS 'price_evidence';
-- Price evidence must come from a verified registry seller; recorded at upload.
ALTER TABLE files ADD COLUMN seller_id UUID REFERENCES spare_parts_sellers(id);

-- ================================================================ labor counters
ALTER TABLE quote_counters
  -- Labor-only policy for the job's category when the counter was made (switching later never rewrites history).
  ADD COLUMN labor_only_policy_snapshot labor_only_policy,
  -- Labor negotiation rounds: the technician may counter the customer's proposal.
  ADD COLUMN parent_counter_id UUID REFERENCES quote_counters(id),
  ADD COLUMN created_by_role   TEXT NOT NULL DEFAULT 'customer' CHECK (created_by_role IN ('customer', 'technician')),
  ADD COLUMN awaiting          TEXT NOT NULL DEFAULT 'technician' CHECK (awaiting IN ('customer', 'technician'));
ALTER TYPE counter_status ADD VALUE IF NOT EXISTS 'countered';

CREATE TABLE labor_only_rejections (
  id            BIGSERIAL PRIMARY KEY,
  technician_id UUID NOT NULL REFERENCES users(id),
  category_id   INT NOT NULL REFERENCES service_categories(id),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  counter_id    UUID NOT NULL UNIQUE REFERENCES quote_counters(id) ON DELETE CASCADE,
  penalized     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX labor_only_rejections_window_idx ON labor_only_rejections (technician_id, category_id, created_at);

-- Rating penalties reduce the displayed rolling rating while active.
CREATE TABLE rating_penalties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES users(id),
  points        NUMERIC(3,2) NOT NULL CHECK (points > 0),
  reason        TEXT NOT NULL,
  source        TEXT NOT NULL,                  -- labor_only_rejections | admin
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rating_penalties_active_idx ON rating_penalties (technician_id, expires_at);

CREATE TYPE technician_flag_status AS ENUM ('open', 'resolved');
CREATE TABLE technician_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id   UUID NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL,                -- labor_only_rejections | rate_swing | manual
  details         JSONB NOT NULL DEFAULT '{}',
  status          technician_flag_status NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_flags_open_idx ON technician_flags (created_at) WHERE status = 'open';

-- ================================================================ price challenges (parts)
CREATE TYPE price_challenge_status AS ENUM (
  'pending', 'matched', 'explained', 'held_firm', 'auto_approved', 'auto_cancelled',
  'admin_approved', 'admin_upheld', 'withdrawn', 'superseded'
);
CREATE TABLE price_challenges (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id             UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_revision       INT NOT NULL,
  customer_id          UUID NOT NULL REFERENCES users(id),
  technician_id        UUID NOT NULL REFERENCES users(id),
  fast_track           BOOLEAN NOT NULL DEFAULT false,
  status               price_challenge_status NOT NULL DEFAULT 'pending',
  message              TEXT,
  evidence_file_ids    UUID[] NOT NULL CHECK (cardinality(evidence_file_ids) > 0),
  technician_response  TEXT,
  responded_at         TIMESTAMPTZ,
  reminders_sent       INT NOT NULL DEFAULT 0,
  response_due_at      TIMESTAMPTZ NOT NULL,
  escalated_at         TIMESTAMPTZ,
  final_action_at      TIMESTAMPTZ NOT NULL,
  resolved_at          TIMESTAMPTZ,
  resolved_by          UUID REFERENCES users(id),
  resolution_note      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_challenges_one_pending ON price_challenges (quote_id) WHERE status = 'pending';
CREATE INDEX price_challenges_open_idx ON price_challenges (fast_track DESC, created_at) WHERE status = 'pending';

CREATE TABLE price_challenge_lines (
  challenge_id              UUID NOT NULL REFERENCES price_challenges(id) ON DELETE CASCADE,
  quote_item_id             UUID NOT NULL REFERENCES quote_items(id) ON DELETE CASCADE,
  description               TEXT NOT NULL,
  current_unit_price_minor  BIGINT NOT NULL,
  proposed_unit_price_minor BIGINT NOT NULL CHECK (proposed_unit_price_minor >= 0),
  PRIMARY KEY (challenge_id, quote_item_id),
  CHECK (proposed_unit_price_minor < current_unit_price_minor)
);

-- ================================================================ labor rate adjustment (Section 7a)
ALTER TABLE technician_profiles
  ADD COLUMN rate_adjustment_bps  INT NOT NULL DEFAULT 0,
  ADD COLUMN rate_tier_stars      SMALLINT CHECK (rate_tier_stars BETWEEN 1 AND 5),
  ADD COLUMN rate_rating_used     NUMERIC(3,2),
  ADD COLUMN rate_calculated_at   TIMESTAMPTZ,
  ADD COLUMN rate_override_bps    INT,                       -- admin manual override
  ADD COLUMN rate_held_for_review BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE rate_adjustment_status AS ENUM ('applied', 'held', 'admin_approved', 'admin_rejected');
CREATE TABLE technician_rate_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id         UUID NOT NULL REFERENCES users(id),
  rating_used           NUMERIC(3,2),
  rating_without_latest NUMERIC(3,2),
  previous_stars        SMALLINT,
  new_stars             SMALLINT,
  previous_bps          INT NOT NULL,
  new_bps               INT NOT NULL,
  status                rate_adjustment_status NOT NULL,
  flag_id               UUID REFERENCES technician_flags(id),
  decided_by            UUID REFERENCES users(id),
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_rate_adjustments_tech_idx ON technician_rate_adjustments (technician_id, created_at DESC);

-- Quotes keep the adjustment in force when they were first submitted (future quotes only).
ALTER TABLE quotes ADD COLUMN performance_adjustment_bps INT NOT NULL DEFAULT 0;
