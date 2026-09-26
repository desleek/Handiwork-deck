-- Section 4: technician flow. Section 5: pricing model. Section 5a: Demand Notice.

-- ================================================================ admin-configurable settings
-- key -> JSON value. Missing keys fall back to defaults in src/services/settings.ts.
CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================================ per-category labor-only declarations
CREATE TYPE labor_only_policy AS ENUM ('accept', 'decline');
ALTER TABLE technician_services ADD COLUMN labor_only_policy labor_only_policy;
UPDATE technician_services ts SET labor_only_policy =
  CASE WHEN tp.labor_stance = 'no_labor_only' THEN 'decline'::labor_only_policy ELSE 'accept'::labor_only_policy END
  FROM technician_profiles tp WHERE tp.user_id = ts.technician_id;
ALTER TABLE technician_services ALTER COLUMN labor_only_policy SET NOT NULL;
ALTER TABLE technician_profiles DROP COLUMN labor_stance;
DROP TYPE labor_stance;

-- Append-only: survives removing/re-adding a service so the cooldown can't be dodged.
CREATE TABLE technician_labor_only_declarations (
  id            BIGSERIAL PRIMARY KEY,
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  category_id   INT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  policy        labor_only_policy NOT NULL,
  declared_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_labor_only_declarations_idx ON technician_labor_only_declarations (technician_id, category_id, declared_at DESC);
INSERT INTO technician_labor_only_declarations (technician_id, category_id, policy)
  SELECT technician_id, category_id, labor_only_policy FROM technician_services;

-- ================================================================ technician profile additions
ALTER TABLE technician_profiles
  ADD COLUMN timezone               TEXT NOT NULL DEFAULT 'Africa/Lagos',
  ADD COLUMN markup_cap_bps_override INT CHECK (markup_cap_bps_override BETWEEN 0 AND 100000),
  ADD COLUMN payout_currency        CHAR(3),
  ADD COLUMN payout_recipient_ref   TEXT,        -- Paystack transfer recipient code
  ADD COLUMN payout_bank_code       TEXT,        -- Flutterwave transfers need raw bank details
  ADD COLUMN payout_account_number  TEXT,
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ;

-- ================================================================ availability calendar
CREATE TABLE technician_availability (
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time),
  PRIMARY KEY (technician_id, day_of_week, start_time)
);
CREATE TABLE technician_time_off (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  reason        TEXT,
  CHECK (ends_at > starts_at)
);
CREATE INDEX technician_time_off_idx ON technician_time_off (technician_id, ends_at);

-- Is the technician working at `at`? No weekly hours set = no restriction (only time off applies).
CREATE FUNCTION technician_available_at(tech UUID, at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM technician_time_off o WHERE o.technician_id = tech AND at >= o.starts_at AND at < o.ends_at)
     AND (
       NOT EXISTS (SELECT 1 FROM technician_availability a WHERE a.technician_id = tech)
       OR EXISTS (
         SELECT 1 FROM technician_availability a JOIN technician_profiles tp ON tp.user_id = a.technician_id
          WHERE a.technician_id = tech
            AND a.day_of_week = extract(dow FROM at AT TIME ZONE tp.timezone)
            AND (at AT TIME ZONE tp.timezone)::time >= a.start_time
            AND (at AT TIME ZONE tp.timezone)::time < a.end_time)
     )
$$;

-- ================================================================ job requests
ALTER TABLE jobs
  ADD COLUMN request_accepted_at    TIMESTAMPTZ,
  -- Commission rates snapshotted when the quote is accepted, so later admin changes don't re-price agreed work.
  ADD COLUMN labor_commission_bps   INT,
  ADD COLUMN markup_commission_bps  INT;

-- "Not interested" on the job feed.
CREATE TABLE job_dismissals (
  technician_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (technician_id, job_id)
);

-- ================================================================ pricing: labor vs parts, disclosed markup
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'pending_exception' AFTER 'pending';
ALTER TABLE quote_items
  ADD COLUMN base_minor      BIGINT,
  ADD COLUMN markup_bps      INT NOT NULL DEFAULT 0 CHECK (markup_bps >= 0),
  ADD COLUMN markup_minor    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN receipt_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN applies_to      TEXT CHECK (applies_to IN ('labor', 'markup'));
-- Pre-Section-5 lines: transport/other become labor; everything's base is its total.
UPDATE quote_items SET kind = 'labor' WHERE kind IN ('transport', 'other');
UPDATE quote_items SET base_minor = total_minor;
UPDATE quote_items SET applies_to = 'labor' WHERE kind = 'adjustment';
ALTER TABLE quote_items
  ALTER COLUMN base_minor SET NOT NULL,
  ADD CONSTRAINT quote_items_total_is_base_plus_markup CHECK (total_minor = base_minor + markup_minor),
  ADD CONSTRAINT quote_items_markup_only_on_parts CHECK (kind = 'material' OR (markup_bps = 0 AND markup_minor = 0)),
  ADD CONSTRAINT quote_items_no_new_legacy_kinds CHECK (kind IN ('labor', 'material', 'adjustment')),
  ADD CONSTRAINT quote_items_adjustment_target CHECK ((kind = 'adjustment') = (applies_to IS NOT NULL));

ALTER TABLE quotes
  ADD COLUMN parts_base_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN markup_minor     BIGINT NOT NULL DEFAULT 0;
UPDATE quotes SET parts_base_minor = materials_minor;

-- ================================================================ Demand Notice (markup cap exceptions)
CREATE TYPE cap_exception_status AS ENUM ('pending', 'approved', 'declined', 'withdrawn');
CREATE TABLE cap_exception_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id             UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_item_id        UUID REFERENCES quote_items(id) ON DELETE SET NULL,
  quote_revision       INT NOT NULL,
  technician_id        UUID NOT NULL REFERENCES users(id),
  line_description     TEXT NOT NULL,
  base_minor           BIGINT NOT NULL,
  currency             CHAR(3) NOT NULL,
  requested_markup_bps INT NOT NULL,
  cap_bps              INT NOT NULL,
  reason               TEXT NOT NULL,
  evidence_file_ids    UUID[] NOT NULL,
  status               cap_exception_status NOT NULL DEFAULT 'pending',
  admin_note           TEXT,
  decided_by           UUID REFERENCES users(id),
  decided_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requested_markup_bps > cap_bps),
  CHECK (cardinality(evidence_file_ids) > 0)
);
CREATE INDEX cap_exception_requests_pending_idx ON cap_exception_requests (created_at) WHERE status = 'pending';
CREATE INDEX cap_exception_requests_quote_idx ON cap_exception_requests (quote_id);

-- ================================================================ job audit trail
CREATE TABLE job_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id),     -- NULL = system
  action     TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_audit_log_job_idx ON job_audit_log (job_id, id);

-- ================================================================ payouts
ALTER TYPE wallet_entry_kind ADD VALUE IF NOT EXISTS 'promotion';
ALTER TYPE wallet_entry_kind ADD VALUE IF NOT EXISTS 'fee';
CREATE TYPE payout_speed AS ENUM ('standard', 'instant');
CREATE TYPE payout_status AS ENUM ('requested', 'processing', 'sent', 'failed');
CREATE TABLE payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id  UUID NOT NULL REFERENCES users(id),
  currency       CHAR(3) NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),   -- debited from the wallet
  fee_minor      BIGINT NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  net_minor      BIGINT NOT NULL CHECK (net_minor > 0),      -- sent to the bank
  speed          payout_speed NOT NULL,
  status         payout_status NOT NULL DEFAULT 'requested',
  provider       payment_provider,
  provider_ref   TEXT,
  failure_reason TEXT,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (net_minor = amount_minor - fee_minor)
);
CREATE INDEX payouts_tech_idx ON payouts (technician_id, created_at DESC);
CREATE INDEX payouts_due_idx ON payouts (scheduled_for) WHERE status = 'requested';
CREATE TRIGGER payouts_touch BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE wallet_ledger ADD COLUMN payout_id UUID REFERENCES payouts(id);
CREATE UNIQUE INDEX wallet_ledger_payout_once ON wallet_ledger (payout_id, kind) WHERE payout_id IS NOT NULL;

-- ================================================================ promotions (boosts & priority alerts)
CREATE TABLE technician_alert_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  radius_factor NUMERIC(4,2) NOT NULL DEFAULT 2,     -- hears about jobs this many times further away
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX technician_alert_subscriptions_active_idx ON technician_alert_subscriptions (technician_id, ends_at);
CREATE TABLE promotion_purchases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id         UUID NOT NULL REFERENCES users(id),
  product               TEXT NOT NULL,
  category_id           INT REFERENCES service_categories(id),
  price_minor           BIGINT NOT NULL,
  currency              CHAR(3) NOT NULL,
  boost_id              UUID REFERENCES technician_boosts(id),
  alert_subscription_id UUID REFERENCES technician_alert_subscriptions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE wallet_ledger ADD COLUMN promotion_id UUID REFERENCES promotion_purchases(id);

-- ================================================================ technicians rate customers
CREATE TABLE customer_ratings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES users(id),
  customer_id   UUID NOT NULL REFERENCES users(id),
  scores        JSONB NOT NULL,
  overall       NUMERIC(3,2) NOT NULL,
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users
  ADD COLUMN customer_rating_avg   NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN customer_rating_count INT NOT NULL DEFAULT 0;

-- A technician suggesting a new trade declares their labor-only policy for it up front,
-- so the service can be added to their profile when an admin approves it.
ALTER TABLE category_suggestions ADD COLUMN labor_only_policy labor_only_policy;
