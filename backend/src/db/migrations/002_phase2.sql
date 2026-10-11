-- Phase 2: advertising lifecycle & tracking, boost/alert bookkeeping.
-- The ads module stays isolated: no core table gains a reference to an ad table.

-- ---------------------------------------------------------------- advertisers (future self-serve)
CREATE TABLE advertiser_profiles (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name   TEXT NOT NULL,
  contact_email  TEXT,
  contact_phone  TEXT,
  seller_id      UUID REFERENCES parts_sellers(id),   -- links a brand/seller in the verified registry
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- campaign lifecycle
ALTER TABLE ad_campaigns
  ADD COLUMN days              INTEGER CHECK (days > 0),
  ADD COLUMN price_minor       BIGINT,                 -- slot price per day × days, frozen at submission
  ADD COLUMN paid_minor        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN payment_status    TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'waived', 'refunded')),
  ADD COLUMN rejection_reason  TEXT,
  ADD COLUMN submitted_at      TIMESTAMPTZ,
  ADD COLUMN reviewed_at       TIMESTAMPTZ,
  ADD COLUMN updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX ad_campaigns_live_idx ON ad_campaigns(placement, status, starts_at, ends_at);

-- One impression / click per user per campaign per day, so counts can't be inflated by re-renders.
ALTER TABLE ad_events ADD COLUMN day DATE NOT NULL DEFAULT current_date;
CREATE UNIQUE INDEX ad_events_dedupe_idx ON ad_events(campaign_id, user_id, type, day) WHERE user_id IS NOT NULL;
CREATE INDEX ad_events_campaign_idx ON ad_events(campaign_id, type, created_at);

-- ---------------------------------------------------------------- boosts & alerts
ALTER TABLE boosts ADD COLUMN cancelled_reason TEXT;
CREATE INDEX boosts_technician_idx ON boosts(technician_id, created_at DESC);
CREATE INDEX push_alert_sends_tech_idx ON push_alert_sends(technician_id, created_at DESC);
