-- Handiwork-Deck core schema.
-- Conventions:
--   * Money is stored as BIGINT in minor units (kobo for NGN, cents for USD) in columns ending `_minor`.
--   * Percentages are stored as INTEGER basis points (1% = 100 bps) in columns ending `_bps`.
--   * Every tunable business rule lives in `platform_settings` (admin-configurable), never hardcoded.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- Users & roles
-- =====================================================================
CREATE TYPE user_role AS ENUM ('customer', 'technician', 'advertiser', 'admin');
CREATE TYPE account_status AS ENUM ('active', 'restricted', 'suspended', 'deleted');

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid        TEXT UNIQUE,
  role                user_role NOT NULL,
  full_name           TEXT NOT NULL,
  email               TEXT,
  phone_e164          TEXT,                       -- real number: never exposed before job approval (Section 8)
  avatar_url          TEXT,
  status              account_status NOT NULL DEFAULT 'active',
  completion_badge    BOOLEAN NOT NULL DEFAULT FALSE,  -- Section 7 platform completion badge (customers)
  wallet_bonus_until  TIMESTAMPTZ,                -- Section 15: defaults to created_at + 3 months, admin-extendable
  default_currency    CHAR(3) NOT NULL DEFAULT 'NGN',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ                 -- store-mandated account deletion flow
);
CREATE INDEX users_role_idx ON users(role);

CREATE TABLE device_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_prefs (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  promotional_alerts   BOOLEAN NOT NULL DEFAULT TRUE,   -- Section 16b opt-out; transactional alerts are always on
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Admin-configurable settings (Section 19)
-- =====================================================================
CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before      JSONB,
  after       JSONB,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Service category taxonomy (Section 2) — admin-managed, never hardcoded
-- =====================================================================
CREATE TYPE supercategory AS ENUM ('household_office', 'construction');

CREATE TABLE service_categories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supercategory     supercategory NOT NULL,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  icon              TEXT NOT NULL DEFAULT 'wrench',
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  is_custom         BOOLEAN NOT NULL DEFAULT FALSE,   -- "Other/custom" entries, admin-approved
  approval_status   TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  requested_by      UUID REFERENCES users(id),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supercategory, name)
);

-- =====================================================================
-- Technicians (Section 4)
-- =====================================================================
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE labor_only_stance AS ENUM ('accept', 'decline_from_inception');

CREATE TABLE technician_profiles (
  user_id                    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio                        TEXT,
  verification_status        verification_status NOT NULL DEFAULT 'pending',
  id_document_url            TEXT,
  coverage_lat               DOUBLE PRECISION,
  coverage_lng               DOUBLE PRECISION,
  coverage_radius_km         NUMERIC(6,2) NOT NULL DEFAULT 10,
  is_online                  BOOLEAN NOT NULL DEFAULT FALSE,
  last_lat                   DOUBLE PRECISION,
  last_lng                   DOUBLE PRECISION,
  last_location_at           TIMESTAMPTZ,
  rating_avg                 NUMERIC(3,2),          -- weighted-recent rolling average (Section 7a)
  rating_count               INTEGER NOT NULL DEFAULT 0,
  performance_multiplier_bps INTEGER NOT NULL DEFAULT 0,   -- e.g. 1000 = +10% labor
  multiplier_updated_at      TIMESTAMPTZ,
  markup_cap_override_bps    INTEGER,               -- permanent per-technician Demand Notice override (Section 5a)
  boost_privileges_suspended BOOLEAN NOT NULL DEFAULT FALSE,  -- Section 16 lighter-touch interim measure
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_online_idx ON technician_profiles(is_online) WHERE is_online;

CREATE TABLE technician_categories (
  technician_id        UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  category_id          UUID NOT NULL REFERENCES service_categories(id),
  starting_price_minor BIGINT NOT NULL CHECK (starting_price_minor >= 0),  -- standard labor rate before multiplier
  labor_only_stance    labor_only_stance NOT NULL,
  stance_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (technician_id, category_id)
);

-- Stance switches are logged; prior rejection counts are never erased (Section 6b)
CREATE TABLE labor_only_stance_history (
  id             BIGSERIAL PRIMARY KEY,
  technician_id  UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  category_id    UUID NOT NULL REFERENCES service_categories(id),
  from_stance    labor_only_stance,
  to_stance      labor_only_stance NOT NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE certifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id  UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  issuer         TEXT,
  file_url       TEXT NOT NULL,
  status         verification_status NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE moderation_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE portfolio_images (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id      UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  caption            TEXT,
  position           SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 5),
  moderation_status  moderation_status NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (technician_id, position)          -- max 5 portfolio images, enforced by schema
);

CREATE TABLE availability_slots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id  UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  weekday        SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time     TIME NOT NULL,
  end_time       TIME NOT NULL CHECK (end_time > start_time)
);

CREATE TABLE multiplier_history (
  id               BIGSERIAL PRIMARY KEY,
  technician_id    UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  rating_avg       NUMERIC(3,2),
  from_bps         INTEGER NOT NULL,
  to_bps           INTEGER NOT NULL,
  flagged_anomaly  BOOLEAN NOT NULL DEFAULT FALSE,
  review_status    TEXT CHECK (review_status IN ('pending', 'confirmed', 'overridden')),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Verified spare-parts-seller registry (Section 10).
-- Designed to double as the future supplier/vendor table (Section 13).
-- =====================================================================
CREATE TYPE seller_verification AS ENUM ('unlisted_review', 'provisional', 'verified', 'flagged', 'removed');

CREATE TABLE parts_sellers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  registration_no      TEXT,
  contact_phone        TEXT,
  contact_email        TEXT,
  address              TEXT,
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  category_ids         UUID[] NOT NULL DEFAULT '{}',
  verification_status  seller_verification NOT NULL DEFAULT 'provisional',
  source               TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'organic', 'advertiser')),
  clean_approvals      INTEGER NOT NULL DEFAULT 0,
  merged_into          UUID REFERENCES parts_sellers(id),
  -- Future supplies storefront (Section 13), unused in MVP:
  storefront_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  owner_user_id        UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX parts_sellers_name_idx ON parts_sellers (lower(name));

-- =====================================================================
-- Jobs (Sections 3, 4, 18)
-- =====================================================================
CREATE TYPE job_kind AS ENUM ('standard', 'construction');
CREATE TYPE booking_type AS ENUM ('instant', 'request');
CREATE TYPE job_status AS ENUM (
  'requested',          -- awaiting technician accept/decline
  'accepted',           -- technician accepted, quote expected
  'quoted',             -- quote submitted, customer to respond
  'negotiating',        -- labor-only / price challenge / labor negotiation in progress
  'approved',           -- quote approved, awaiting payment
  'funded',             -- payment held in escrow
  'en_route',
  'in_progress',
  'awaiting_confirmation', -- technician marked complete
  'completed',          -- customer confirmed, funds split
  'cancelled',
  'declined',
  'incomplete',         -- timed out (Section 18)
  'disputed'
);
CREATE TYPE action_party AS ENUM ('customer', 'technician', 'admin', 'none');

CREATE TABLE jobs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code             TEXT NOT NULL UNIQUE,         -- used in WhatsApp relay ("#HW7K2Q")
  kind                   job_kind NOT NULL DEFAULT 'standard',
  booking_type           booking_type NOT NULL,
  customer_id            UUID NOT NULL REFERENCES users(id),
  technician_id          UUID NOT NULL REFERENCES technician_profiles(user_id),
  category_id            UUID NOT NULL REFERENCES service_categories(id),
  status                 job_status NOT NULL DEFAULT 'requested',
  description            TEXT NOT NULL,
  address                TEXT NOT NULL,
  lat                    DOUBLE PRECISION,
  lng                    DOUBLE PRECISION,
  scheduled_for          TIMESTAMPTZ,
  is_fast_track          BOOLEAN NOT NULL DEFAULT FALSE,
  currency               CHAR(3) NOT NULL DEFAULT 'NGN',
  -- Section 18: timestamped "action required from" state, maintained at all times
  action_required_from   action_party NOT NULL DEFAULT 'technician',
  action_required_reason TEXT,
  action_required_since  TIMESTAMPTZ NOT NULL DEFAULT now(),
  contacts_released_at   TIMESTAMPTZ,                  -- Section 8
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  cancelled_by           UUID REFERENCES users(id),
  cancel_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_customer_idx ON jobs(customer_id, created_at DESC);
CREATE INDEX jobs_technician_idx ON jobs(technician_id, created_at DESC);
CREATE INDEX jobs_stall_idx ON jobs(action_required_since)
  WHERE status NOT IN ('completed', 'cancelled', 'declined', 'incomplete');

-- Full audit trail per job (Demand Notices, negotiations, escalations, payments...)
CREATE TABLE job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id),     -- NULL = system
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events(job_id, created_at);

-- =====================================================================
-- Quotes: itemized, labor and parts always separate (Section 5)
-- =====================================================================
CREATE TYPE quote_status AS ENUM ('submitted', 'pending_exception', 'approved', 'superseded', 'rejected', 'withdrawn');
CREATE TYPE quote_item_kind AS ENUM ('labor', 'part');

CREATE TABLE quotes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id             UUID NOT NULL REFERENCES technician_profiles(user_id),
  version                   INTEGER NOT NULL,
  status                    quote_status NOT NULL DEFAULT 'submitted',
  -- Frozen at submission so later multiplier/commission changes never touch it (Section 7a)
  applied_multiplier_bps    INTEGER NOT NULL,
  markup_cap_bps            INTEGER NOT NULL,
  labor_commission_bps      INTEGER NOT NULL,
  markup_commission_bps     INTEGER NOT NULL,
  labor_total_minor         BIGINT NOT NULL,
  parts_base_total_minor    BIGINT NOT NULL,
  markup_total_minor        BIGINT NOT NULL,
  customer_total_minor      BIGINT NOT NULL,
  platform_commission_minor BIGINT NOT NULL,
  technician_net_minor      BIGINT NOT NULL,
  labor_only                BOOLEAN NOT NULL DEFAULT FALSE,  -- result of an accepted labor-only counter
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at               TIMESTAMPTZ,
  UNIQUE (job_id, version)
);

CREATE TABLE quote_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind                quote_item_kind NOT NULL,
  description         TEXT NOT NULL,
  quantity            NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost_minor     BIGINT NOT NULL CHECK (unit_cost_minor >= 0),  -- labor: rate after multiplier; part: base cost
  base_labor_minor    BIGINT,                                        -- labor only: rate before multiplier
  markup_bps          INTEGER NOT NULL DEFAULT 0 CHECK (markup_bps >= 0),
  markup_minor        BIGINT NOT NULL DEFAULT 0,
  line_total_minor    BIGINT NOT NULL,
  receipt_url         TEXT,
  seller_id           UUID REFERENCES parts_sellers(id),
  position            SMALLINT NOT NULL,
  CHECK (kind = 'part' OR markup_bps = 0)          -- markup only ever applies to parts
);

-- Section 5a — Demand Notice (markup cap exception)
CREATE TYPE case_status AS ENUM ('pending', 'approved', 'declined', 'withdrawn');

CREATE TABLE markup_exceptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id              UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_item_id         UUID NOT NULL REFERENCES quote_items(id) ON DELETE CASCADE,
  technician_id         UUID NOT NULL REFERENCES technician_profiles(user_id),
  requested_markup_bps  INTEGER NOT NULL,
  reason                TEXT NOT NULL,
  evidence_urls         TEXT[] NOT NULL CHECK (cardinality(evidence_urls) > 0),
  status                case_status NOT NULL DEFAULT 'pending',
  decided_by            UUID REFERENCES users(id),
  decision_note         TEXT,
  grant_permanent_bps   INTEGER,      -- if admin also grants a permanent per-technician override
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ
);

-- Section 6b — labor-only counters
CREATE TABLE labor_only_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id            UUID NOT NULL REFERENCES quotes(id),
  technician_id       UUID NOT NULL REFERENCES technician_profiles(user_id),
  category_id         UUID NOT NULL REFERENCES service_categories(id),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  stance_at_request   labor_only_stance NOT NULL,
  counts_as_rejection BOOLEAN NOT NULL DEFAULT FALSE,   -- only when stance was 'accept' and tech rejected
  penalty_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at        TIMESTAMPTZ
);
CREATE INDEX labor_only_rejections_idx ON labor_only_requests(technician_id, category_id, responded_at)
  WHERE counts_as_rejection;

-- Section 6c — price challenges (parts, pre-job)
CREATE TYPE challenge_status AS ENUM (
  'pending_evidence_review', -- seller not in registry: case-by-case admin review
  'open', 'matched', 'explained', 'held_firm',
  'escalated', 'auto_approved', 'auto_cancelled', 'evidence_rejected', 'withdrawn'
);

CREATE TABLE price_challenges (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id               UUID NOT NULL REFERENCES quotes(id),
  quote_item_id          UUID NOT NULL REFERENCES quote_items(id),
  customer_id            UUID NOT NULL REFERENCES users(id),
  technician_id          UUID NOT NULL REFERENCES technician_profiles(user_id),
  seller_id              UUID REFERENCES parts_sellers(id),
  unlisted_seller_name   TEXT,
  evidence_url           TEXT NOT NULL,
  claimed_unit_cost_minor BIGINT NOT NULL CHECK (claimed_unit_cost_minor >= 0),
  is_fast_track          BOOLEAN NOT NULL DEFAULT FALSE,
  status                 challenge_status NOT NULL DEFAULT 'open',
  technician_response    TEXT CHECK (technician_response IN ('match', 'explain', 'hold')),
  response_note          TEXT,
  notifications_sent     INTEGER NOT NULL DEFAULT 0,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at           TIMESTAMPTZ,
  escalated_at           TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  final_action           TEXT,
  CHECK (seller_id IS NOT NULL OR unlisted_seller_name IS NOT NULL)
);
CREATE INDEX price_challenges_open_idx ON price_challenges(status) WHERE status IN ('open', 'escalated');

-- Section 6d — labor cost negotiation (job-scoped only)
CREATE TABLE labor_negotiations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id                 UUID NOT NULL REFERENCES quotes(id),
  standard_labor_minor     BIGINT NOT NULL,   -- incl. multiplier, at time of request
  proposed_labor_minor     BIGINT NOT NULL,
  counter_labor_minor      BIGINT,
  final_labor_minor        BIGINT,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'countered', 'accepted', 'declined', 'counter_accepted', 'counter_rejected')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (proposed_labor_minor < standard_labor_minor)
);

-- =====================================================================
-- Ratings & reviews (Section 7)
-- =====================================================================
CREATE TABLE technician_ratings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL UNIQUE REFERENCES jobs(id),
  customer_id      UUID NOT NULL REFERENCES users(id),
  technician_id    UUID NOT NULL REFERENCES technician_profiles(user_id),
  category_id      UUID NOT NULL REFERENCES service_categories(id),
  competence       SMALLINT NOT NULL CHECK (competence BETWEEN 1 AND 5),
  punctuality      SMALLINT NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  professionalism  SMALLINT NOT NULL CHECK (professionalism BETWEEN 1 AND 5),
  courtesy         SMALLINT NOT NULL CHECK (courtesy BETWEEN 1 AND 5),
  delivery_timeline SMALLINT NOT NULL CHECK (delivery_timeline BETWEEN 1 AND 5),
  pricing_fairness SMALLINT NOT NULL CHECK (pricing_fairness BETWEEN 1 AND 5),
  quality_of_work  SMALLINT NOT NULL CHECK (quality_of_work BETWEEN 1 AND 5),
  overall          NUMERIC(3,2) NOT NULL,
  review_text      TEXT NOT NULL CHECK (length(trim(review_text)) >= 10),
  moderation_status moderation_status NOT NULL DEFAULT 'approved',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_ratings_tech_idx ON technician_ratings(technician_id, created_at DESC);

CREATE TABLE customer_ratings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL UNIQUE REFERENCES jobs(id),
  technician_id          UUID NOT NULL REFERENCES technician_profiles(user_id),
  customer_id            UUID NOT NULL REFERENCES users(id),
  on_site_as_scheduled   SMALLINT NOT NULL CHECK (on_site_as_scheduled BETWEEN 1 AND 5),
  granted_access         SMALLINT NOT NULL CHECK (granted_access BETWEEN 1 AND 5),
  paid_through_platform  SMALLINT NOT NULL CHECK (paid_through_platform BETWEEN 1 AND 5),
  respectful_conduct     SMALLINT NOT NULL CHECK (respectful_conduct BETWEEN 1 AND 5),
  overall                NUMERIC(3,2) NOT NULL,
  comment                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Messaging (Section 8)
-- =====================================================================
CREATE TABLE chat_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sender_id      UUID REFERENCES users(id),             -- NULL = system message
  body           TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'whatsapp', 'system')),
  client_msg_id  TEXT,                                   -- offline queue de-duplication
  external_id    TEXT,                                   -- WhatsApp message id
  redacted       BOOLEAN NOT NULL DEFAULT FALSE,         -- phone numbers stripped pre-approval
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sender_id, client_msg_id)
);
CREATE INDEX chat_messages_job_idx ON chat_messages(job_id, created_at);

-- Which job a technician's next WhatsApp reply is routed to
CREATE TABLE whatsapp_relay_sessions (
  technician_id   UUID PRIMARY KEY REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  last_outbound_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}',
  transactional  BOOLEAN NOT NULL DEFAULT TRUE,
  channels       TEXT[] NOT NULL DEFAULT '{push}',
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

-- =====================================================================
-- Payments, escrow, wallet (Sections 5, 11, 15)
-- =====================================================================
CREATE TYPE payment_purpose AS ENUM ('job', 'consultancy', 'milestone', 'boost', 'push_alert', 'wallet_topup', 'ad_campaign');
CREATE TYPE payment_channel AS ENUM ('card', 'bank_transfer', 'wallet', 'ussd');
CREATE TYPE payment_status AS ENUM ('initiated', 'held', 'captured', 'partially_refunded', 'refunded', 'failed', 'cancelled');

CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id         UUID NOT NULL REFERENCES users(id),
  purpose          payment_purpose NOT NULL,
  job_id           UUID REFERENCES jobs(id),
  quote_id         UUID REFERENCES quotes(id),
  milestone_id     UUID,                  -- FK added in construction section
  boost_id         UUID,
  channel          payment_channel NOT NULL,
  provider         TEXT NOT NULL,         -- 'paystack' | 'flutterwave' | 'stripe' | 'wallet' | 'mock'
  provider_ref     TEXT UNIQUE,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  currency         CHAR(3) NOT NULL DEFAULT 'NGN',
  processing_fee_minor BIGINT,
  status           payment_status NOT NULL DEFAULT 'initiated',
  checkout         JSONB NOT NULL DEFAULT '{}',   -- authorization URL / virtual account / USSD code
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  held_at          TIMESTAMPTZ,
  captured_at      TIMESTAMPTZ
);
CREATE INDEX payments_job_idx ON payments(job_id);

-- Itemized capture → split (Section 11): one row per recipient & component
CREATE TABLE payment_splits (
  id             BIGSERIAL PRIMARY KEY,
  payment_id     UUID NOT NULL REFERENCES payments(id),
  recipient      TEXT NOT NULL CHECK (recipient IN ('platform', 'technician', 'customer_refund')),
  user_id        UUID REFERENCES users(id),
  component      TEXT NOT NULL,   -- labor, labor_commission, parts_base, markup, markup_commission, consultancy, boost...
  amount_minor   BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)      -- idempotency
);

CREATE TABLE virtual_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  provider        TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  account_name    TEXT NOT NULL,
  is_dedicated    BOOLEAN NOT NULL DEFAULT TRUE,   -- per customer vs per transaction
  payment_id      UUID REFERENCES payments(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallets (
  user_id        UUID PRIMARY KEY REFERENCES users(id),
  balance_minor  BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'NGN',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, auditable ledger (Section 15)
CREATE TYPE ledger_entry_type AS ENUM (
  'topup', 'topup_bonus', 'job_payment', 'earning', 'refund',
  'withdrawal', 'withdrawal_fee', 'withdrawal_reversal', 'boost_purchase', 'adjustment'
);

CREATE TABLE wallet_ledger (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id),
  type                ledger_entry_type NOT NULL,
  amount_minor        BIGINT NOT NULL,          -- signed: credits positive, debits negative
  balance_after_minor BIGINT NOT NULL,
  payment_id          UUID REFERENCES payments(id),
  job_id              UUID REFERENCES jobs(id),
  withdrawal_id       UUID,
  description         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger(user_id, created_at DESC);

CREATE TABLE bank_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_code       TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  account_last4   TEXT NOT NULL,
  account_name    TEXT NOT NULL,
  provider_recipient_code TEXT,      -- provider-tokenized; full account number is not stored here
  is_default      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE withdrawals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  bank_account_id  UUID NOT NULL REFERENCES bank_accounts(id),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  fee_minor        BIGINT NOT NULL DEFAULT 0,
  speed            TEXT NOT NULL CHECK (speed IN ('standard', 'instant')),
  provider         TEXT,
  provider_ref     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'reversed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE TABLE wallet_bonus_extensions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID REFERENCES users(id),       -- NULL with scope='global' or 'cohort'
  scope          TEXT NOT NULL CHECK (scope IN ('single', 'cohort', 'global')),
  cohort_filter  JSONB,
  new_until      TIMESTAMPTZ NOT NULL,
  reason         TEXT NOT NULL,
  granted_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Disputes & moderation
-- =====================================================================
CREATE TABLE disputes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id),
  quote_item_id  UUID REFERENCES quote_items(id),   -- line-item level (Section 19)
  milestone_id   UUID,
  raised_by      UUID NOT NULL REFERENCES users(id),
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_customer', 'resolved_technician', 'split', 'withdrawn')),
  resolution     TEXT,
  refund_minor   BIGINT,
  resolved_by    UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

CREATE TABLE content_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID NOT NULL REFERENCES users(id),
  target_type  TEXT NOT NULL CHECK (target_type IN ('portfolio_image', 'review', 'chat_message', 'user', 'ad')),
  target_id    UUID NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Incomplete transaction penalties (Section 18)
-- =====================================================================
CREATE TABLE incomplete_strikes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  job_id      UUID NOT NULL REFERENCES jobs(id),
  party       action_party NOT NULL CHECK (party IN ('customer', 'technician')),
  reason      TEXT,
  voided      BOOLEAN NOT NULL DEFAULT FALSE,     -- admin can void on review/appeal
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, user_id)
);

CREATE TABLE fault_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL UNIQUE REFERENCES jobs(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'customer_fault', 'technician_fault', 'no_fault')),
  reviewed_by  UUID REFERENCES users(id),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);

CREATE TABLE account_restrictions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id),
  tier                 SMALLINT NOT NULL CHECK (tier IN (1, 2)),
  restricted_functions TEXT[] NOT NULL,
  starts_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at              TIMESTAMPTZ,         -- NULL for tier 2 suspension
  lifted_at            TIMESTAMPTZ,
  lifted_by            UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_restrictions_active_idx ON account_restrictions(user_id) WHERE lifted_at IS NULL;

CREATE TABLE appeals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  restriction_id  UUID NOT NULL REFERENCES account_restrictions(id),
  statement       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'overturned')),
  decided_by      UUID REFERENCES users(id),
  decision_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

-- =====================================================================
-- Section 16 — visibility boosts & push alerts (Phase 2 feature, schema now)
-- =====================================================================
CREATE TABLE boosts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id       UUID NOT NULL REFERENCES technician_profiles(user_id),
  category_id         UUID NOT NULL REFERENCES service_categories(id),
  rate_per_hour_minor BIGINT NOT NULL CHECK (rate_per_hour_minor > 0),
  hours               INTEGER NOT NULL CHECK (hours > 0),
  total_minor         BIGINT NOT NULL,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  payment_id          UUID REFERENCES payments(id),
  status              TEXT NOT NULL DEFAULT 'pending_payment'
                      CHECK (status IN ('pending_payment', 'scheduled', 'active', 'ended', 'cancelled')),
  rating_at_purchase  NUMERIC(3,2) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX boosts_live_idx ON boosts(category_id, starts_at, ends_at) WHERE status IN ('scheduled', 'active');

CREATE TABLE push_alert_sends (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id       UUID NOT NULL REFERENCES technician_profiles(user_id),
  category_id         UUID NOT NULL REFERENCES service_categories(id),
  fee_minor           BIGINT NOT NULL,
  payment_id          UUID REFERENCES payments(id),
  recipients_count    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'sent', 'failed')),
  rating_at_purchase  NUMERIC(3,2) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

-- Customers who searched/used a category — targeting for push alerts
CREATE TABLE category_interest (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id  UUID NOT NULL REFERENCES service_categories(id),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category_id)
);

-- =====================================================================
-- Section 12 — advertising (isolated bolt-on module; Phase 2)
-- Nothing in the core flow references these tables.
-- =====================================================================
CREATE TABLE ad_campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id     UUID REFERENCES users(id),        -- NULL while admin-managed
  seller_id         UUID REFERENCES parts_sellers(id),
  name              TEXT NOT NULL,
  placement         TEXT NOT NULL CHECK (placement IN ('deals_featured', 'deals_brand', 'sponsored_search')),
  target_category_ids UUID[] NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending_review'
                    CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'active', 'paused', 'ended')),
  slot_price_minor  BIGINT,
  starts_at         TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  reviewed_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_creatives (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT,
  image_url    TEXT NOT NULL,
  click_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_events (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('impression', 'click')),
  user_id      UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Section 17 — construction & plant erection (Phase 3; schema now)
-- =====================================================================
CREATE TABLE site_consultations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  fee_minor        BIGINT NOT NULL CHECK (fee_minor >= 0),
  payment_id       UUID REFERENCES payments(id),
  visit_at         TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'quoted'
                   CHECK (status IN ('quoted', 'paid', 'scheduled', 'visited', 'technician_no_show', 'refunded', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boqs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('builder', 'excel', 'pdf', 'word')),
  source_file_url    TEXT,
  parse_status       TEXT NOT NULL DEFAULT 'not_applicable'
                     CHECK (parse_status IN ('not_applicable', 'parsed', 'needs_review', 'reviewed', 'failed')),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'negotiating', 'approved', 'rejected', 'superseded')),
  grand_total_minor  BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

CREATE TABLE boq_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boq_id             UUID NOT NULL REFERENCES boqs(id) ON DELETE CASCADE,
  kind               quote_item_kind NOT NULL,
  description        TEXT NOT NULL,
  unit               TEXT NOT NULL,
  quantity           NUMERIC(14,3) NOT NULL,
  unit_rate_minor    BIGINT NOT NULL,
  markup_bps         INTEGER NOT NULL DEFAULT 0,
  line_total_minor   BIGINT NOT NULL,
  customer_comment   TEXT,
  proposed_rate_minor BIGINT,
  position           INTEGER NOT NULL
);

CREATE TABLE milestones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  boq_id           UUID NOT NULL REFERENCES boqs(id),
  title            TEXT NOT NULL,
  position         INTEGER NOT NULL,
  labor_minor      BIGINT NOT NULL,
  parts_base_minor BIGINT NOT NULL,
  markup_minor     BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'funded', 'in_progress', 'awaiting_confirmation', 'released', 'disputed')),
  funded_at        TIMESTAMPTZ,
  released_at      TIMESTAMPTZ
);
ALTER TABLE payments ADD CONSTRAINT payments_milestone_fk FOREIGN KEY (milestone_id) REFERENCES milestones(id);
ALTER TABLE payments ADD CONSTRAINT payments_boost_fk FOREIGN KEY (boost_id) REFERENCES boosts(id);

-- =====================================================================
-- Section 13 — supplies marketplace (deferred). Waitlist only.
-- =====================================================================
CREATE TABLE supplies_waitlist (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
