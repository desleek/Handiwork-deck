-- HANDIWORK-DECK core schema.
-- Money is stored as BIGINT minor units alongside an ISO-4217 currency code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('customer', 'technician', 'advertiser', 'admin');
CREATE TYPE customer_type AS ENUM ('homeowner', 'office', 'sme');
CREATE TYPE service_segment AS ENUM ('household_office', 'construction_plant');
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected', 'suspended');
CREATE TYPE job_status AS ENUM ('open', 'quoted', 'assigned', 'en_route', 'in_progress', 'completed', 'paid', 'cancelled', 'disputed');
CREATE TYPE quote_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
CREATE TYPE payment_provider AS ENUM ('stripe', 'paystack', 'flutterwave', 'mock');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
CREATE TYPE ad_status AS ENUM ('draft', 'pending_review', 'active', 'paused', 'rejected', 'ended');
CREATE TYPE file_kind AS ENUM ('portfolio', 'receipt', 'boq', 'avatar', 'ad_creative', 'job_photo', 'id_document');

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid  TEXT NOT NULL UNIQUE,
  role          user_role NOT NULL,
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone_e164    TEXT UNIQUE,           -- used for WhatsApp relay; never exposed to the other party
  customer_type customer_type,          -- only for role = customer
  company_name  TEXT,                   -- offices / SMEs / advertisers
  fcm_tokens    TEXT[] NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role = 'customer' OR customer_type IS NULL)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- catalogue
CREATE TABLE service_categories (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  segment    service_segment NOT NULL,
  parent_id  INT REFERENCES service_categories(id) ON DELETE SET NULL,
  icon       TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- technicians
CREATE TABLE technician_profiles (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio                 TEXT,
  years_experience    INT NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  verification_status verification_status NOT NULL DEFAULT 'pending',
  is_available        BOOLEAN NOT NULL DEFAULT true,
  base_lat            DOUBLE PRECISION,
  base_lng            DOUBLE PRECISION,
  service_radius_km   NUMERIC(6,1) NOT NULL DEFAULT 15,
  rating_avg          NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count        INT NOT NULL DEFAULT 0,
  -- Payee account on the payment provider (Stripe connected account / Paystack or Flutterwave subaccount).
  payout_provider     payment_provider,
  payout_account_ref  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER technician_profiles_touch BEFORE UPDATE ON technician_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE technician_services (
  technician_id    UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  category_id      INT NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  base_rate_minor  BIGINT CHECK (base_rate_minor >= 0),
  currency         CHAR(3),
  PRIMARY KEY (technician_id, category_id)
);
CREATE INDEX technician_services_category_idx ON technician_services (category_id);

-- ---------------------------------------------------------------- files (S3 / Cloudinary)
CREATE TABLE files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         file_kind NOT NULL,
  driver       TEXT NOT NULL,          -- s3 | cloudinary
  storage_key  TEXT NOT NULL,
  url          TEXT,
  content_type TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_owner_idx ON files (owner_id, kind);

CREATE TABLE portfolio_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  caption       TEXT,
  category_id   INT REFERENCES service_categories(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               TEXT NOT NULL UNIQUE,     -- short human-readable reference, e.g. HW-7K2QD
  customer_id       UUID NOT NULL REFERENCES users(id),
  technician_id     UUID REFERENCES users(id),
  category_id       INT NOT NULL REFERENCES service_categories(id),
  title             TEXT NOT NULL,
  description       TEXT,
  address           TEXT NOT NULL,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  status            job_status NOT NULL DEFAULT 'open',
  scheduled_for     TIMESTAMPTZ,
  budget_minor      BIGINT CHECK (budget_minor >= 0),
  currency          CHAR(3) NOT NULL,
  boq_file_id       UUID REFERENCES files(id) ON DELETE SET NULL,   -- bill of quantities (construction)
  match_radius_km   NUMERIC(6,1) NOT NULL DEFAULT 15,
  escalation_level  INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_customer_idx ON jobs (customer_id, created_at DESC);
CREATE INDEX jobs_technician_idx ON jobs (technician_id, created_at DESC);
CREATE INDEX jobs_open_idx ON jobs (category_id, status) WHERE status IN ('open', 'quoted');
CREATE TRIGGER jobs_touch BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE job_status_history (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status job_status,
  to_status   job_status NOT NULL,
  actor_id    UUID REFERENCES users(id),     -- NULL = system
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_status_history_job_idx ON job_status_history (job_id, created_at);

CREATE TABLE job_files (
  job_id  UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, file_id)
);

CREATE TABLE quotes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id  UUID NOT NULL REFERENCES users(id),
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       CHAR(3) NOT NULL,
  message        TEXT,
  eta_minutes    INT,
  status         quote_status NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, technician_id)
);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID NOT NULL REFERENCES jobs(id),
  payer_id           UUID NOT NULL REFERENCES users(id),
  payee_id           UUID NOT NULL REFERENCES users(id),
  provider           payment_provider NOT NULL,
  provider_ref       TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  platform_fee_minor BIGINT NOT NULL CHECK (platform_fee_minor >= 0),
  refunded_minor     BIGINT NOT NULL DEFAULT 0,
  currency           CHAR(3) NOT NULL,
  status             payment_status NOT NULL DEFAULT 'pending',
  checkout_url       TEXT,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_job_idx ON payments (job_id);
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Idempotency log for provider webhooks.
CREATE TABLE webhook_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- reviews
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewee_id UUID NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- WhatsApp relay
-- One conversation per job between its customer and assigned technician, relayed through
-- the platform-owned WhatsApp number so neither side sees the other's phone number.
CREATE TABLE conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES users(id),
  technician_id  UUID NOT NULL REFERENCES users(id),
  is_open        BOOLEAN NOT NULL DEFAULT true,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_customer_idx ON conversations (customer_id, last_message_at DESC) WHERE is_open;
CREATE INDEX conversations_technician_idx ON conversations (technician_id, last_message_at DESC) WHERE is_open;

CREATE TABLE messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID REFERENCES users(id),     -- NULL = platform/system message
  body             TEXT NOT NULL,
  wa_inbound_id    TEXT UNIQUE,                   -- idempotency for WhatsApp webhook retries
  wa_outbound_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------- advertising
CREATE TABLE ad_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  body                TEXT,
  creative_file_id    UUID REFERENCES files(id) ON DELETE SET NULL,
  click_url           TEXT,
  target_category_ids INT[] NOT NULL DEFAULT '{}',   -- empty = all categories
  target_segment      service_segment,
  status              ad_status NOT NULL DEFAULT 'draft',
  budget_minor        BIGINT NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
  spent_minor         BIGINT NOT NULL DEFAULT 0,
  currency            CHAR(3) NOT NULL,
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  impressions         BIGINT NOT NULL DEFAULT 0,
  clicks              BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (status, starts_at, ends_at);
CREATE TRIGGER ad_campaigns_touch BEFORE UPDATE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- escalations / audit
CREATE TABLE escalations (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- no_quote_widen | no_quote_admin | no_show
  level       INT NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX escalations_open_idx ON escalations (created_at) WHERE resolved_at IS NULL;
