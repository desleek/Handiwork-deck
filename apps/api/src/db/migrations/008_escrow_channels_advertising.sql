-- Section 11: every job payment channel feeds escrow-hold -> itemized capture -> split payout.
-- Section 12: advertising as an isolated bolt-on module.

-- ================================================================ escrow
ALTER TABLE jobs
  ADD COLUMN escrow_status TEXT NOT NULL DEFAULT 'unfunded'
    CHECK (escrow_status IN ('unfunded', 'held', 'captured', 'refunded')),
  ADD COLUMN completed_at  TIMESTAMPTZ;

CREATE TABLE escrow_holds (
  job_id                  UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payment_id              UUID NOT NULL UNIQUE REFERENCES payments(id),
  currency                CHAR(3) NOT NULL,
  held_minor              BIGINT NOT NULL CHECK (held_minor > 0),
  status                  TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'captured', 'refunded')),
  funded_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Itemized capture (filled when released):
  captured_minor          BIGINT,
  labor_minor             BIGINT,
  parts_base_minor        BIGINT,
  markup_minor            BIGINT,
  commission_minor        BIGINT,
  technician_payout_minor BIGINT,
  refunded_minor          BIGINT NOT NULL DEFAULT 0,
  released_by             TEXT,           -- customer | auto | admin
  captured_at             TIMESTAMPTZ,
  refunded_at             TIMESTAMPTZ
);

-- Wallet top-ups can arrive via per-customer dedicated virtual accounts.
CREATE TABLE customer_virtual_accounts (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       payment_provider NOT NULL,
  currency       CHAR(3) NOT NULL,
  provider_ref   TEXT NOT NULL,              -- Paystack customer code / Flutterwave tx_ref
  account_number TEXT NOT NULL,
  account_name   TEXT,
  bank_name      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, currency),
  UNIQUE (provider, provider_ref)
);

-- Promotions (Section 16) can be paid through any gateway, not just the wallet.
ALTER TABLE promotion_purchases
  ADD COLUMN status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'failed')),
  ADD COLUMN payment_id UUID REFERENCES payments(id);
ALTER TABLE payments ADD COLUMN promotion_purchase_id UUID REFERENCES promotion_purchases(id);
ALTER TABLE payments DROP CONSTRAINT payments_purpose_shape;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_shape CHECK (
  (purpose = 'job' AND job_id IS NOT NULL AND payee_id IS NOT NULL)
  OR (purpose = 'wallet_topup' AND job_id IS NULL)
  OR (purpose = 'promotion' AND job_id IS NULL AND promotion_purchase_id IS NOT NULL)
);

-- ================================================================ advertising module
CREATE TYPE ad_placement AS ENUM ('featured_seller', 'brand_card', 'sponsored_search');
CREATE TYPE ad_pricing_model AS ENUM ('flat_daily', 'cpm', 'cpc');
ALTER TABLE ad_campaigns
  ALTER COLUMN advertiser_id DROP NOT NULL,                 -- admin-managed campaigns may be for a registry seller
  ADD COLUMN placement        ad_placement NOT NULL DEFAULT 'brand_card',
  ADD COLUMN seller_id        UUID REFERENCES spare_parts_sellers(id) ON DELETE SET NULL,
  ADD COLUMN search_keywords  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN pricing_model    ad_pricing_model NOT NULL DEFAULT 'flat_daily',
  ADD COLUMN rate_minor       BIGINT NOT NULL DEFAULT 0 CHECK (rate_minor >= 0),
  ADD COLUMN managed_by_admin BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN created_by       UUID REFERENCES users(id),
  ADD COLUMN review_note      TEXT,
  ADD CONSTRAINT ad_campaigns_owner CHECK (advertiser_id IS NOT NULL OR seller_id IS NOT NULL),
  ADD CONSTRAINT ad_campaigns_featured_seller CHECK (placement <> 'featured_seller' OR seller_id IS NOT NULL);

CREATE TABLE ad_daily_stats (
  campaign_id   UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  revenue_minor BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);
