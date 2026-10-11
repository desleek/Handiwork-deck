-- Phase 3: construction & plant erection (Section 17) and the Supplies marketplace (Section 13).

-- PG12+: new enum values can be added in a transaction as long as they aren't used in it.
ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'supplies_order';

-- =====================================================================
-- Section 17 — construction
-- =====================================================================
ALTER TABLE site_consultations
  ADD COLUMN technician_id        UUID REFERENCES technician_profiles(user_id),
  ADD COLUMN proposed_visit_at    TIMESTAMPTZ,
  ADD COLUMN visited_at           TIMESTAMPTZ,
  ADD COLUMN no_show_reported_at  TIMESTAMPTZ,
  ADD COLUMN commission_minor     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN refunded_minor       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN note                 TEXT;
ALTER TABLE site_consultations DROP CONSTRAINT site_consultations_status_check;
ALTER TABLE site_consultations ADD CONSTRAINT site_consultations_status_check
  CHECK (status IN ('quoted', 'paid', 'visited', 'technician_no_show', 'disputed', 'refunded', 'cancelled'));

ALTER TABLE boqs
  ADD COLUMN technician_id           UUID REFERENCES technician_profiles(user_id),
  ADD COLUMN notes                   TEXT,
  ADD COLUMN parse_warnings          JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN applied_multiplier_bps  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN markup_cap_bps          INTEGER,
  ADD COLUMN labor_commission_bps    INTEGER,
  ADD COLUMN markup_commission_bps   INTEGER,
  ADD COLUMN labor_total_minor       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN materials_total_minor   BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN markup_total_minor      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN submitted_at            TIMESTAMPTZ,
  ADD COLUMN decided_at              TIMESTAMPTZ,
  ADD COLUMN customer_note           TEXT;

ALTER TABLE boq_items
  ADD COLUMN base_labor_minor   BIGINT,           -- labor rate before performance multiplier
  ADD COLUMN markup_minor       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN milestone_position INTEGER,          -- which agreed milestone this line belongs to
  ADD COLUMN source_row         INTEGER,          -- row in the uploaded file, for traceability
  ADD COLUMN flagged            TEXT;             -- parser uncertainty, cleared on technician review

ALTER TABLE milestones
  ADD COLUMN labor_commission_minor   BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN markup_commission_minor  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN technician_net_minor     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_minor              BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN completed_at             TIMESTAMPTZ,
  ADD COLUMN confirmed_at             TIMESTAMPTZ;
ALTER TABLE milestones DROP CONSTRAINT milestones_status_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_status_check
  CHECK (status IN ('proposed', 'pending', 'funded', 'awaiting_confirmation', 'released', 'disputed', 'refunded', 'cancelled'));
CREATE INDEX milestones_job_idx ON milestones(job_id, position);

ALTER TABLE disputes ADD CONSTRAINT disputes_milestone_fk FOREIGN KEY (milestone_id) REFERENCES milestones(id);

-- =====================================================================
-- Section 13 — Supplies marketplace (sellers from the verified registry become storefronts)
-- =====================================================================
ALTER TABLE parts_sellers
  ADD COLUMN storefront_status    TEXT NOT NULL DEFAULT 'none' CHECK (storefront_status IN ('none', 'pending', 'live', 'suspended')),
  ADD COLUMN pickup_address       TEXT,
  ADD COLUMN offers_delivery      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN delivery_fee_minor   BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN rating_avg           NUMERIC(3,2),
  ADD COLUMN rating_count         INTEGER NOT NULL DEFAULT 0;

CREATE TABLE supply_products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         UUID NOT NULL REFERENCES parts_sellers(id),
  name              TEXT NOT NULL,
  description       TEXT,
  category_ids      UUID[] NOT NULL DEFAULT '{}',
  unit              TEXT NOT NULL DEFAULT 'each',
  price_minor       BIGINT NOT NULL CHECK (price_minor > 0),
  -- [{ "minQty": 10, "unitPriceMinor": 900000, "audience": "all" | "technician" }]
  bulk_tiers        JSONB NOT NULL DEFAULT '[]',
  stock_qty         INTEGER CHECK (stock_qty >= 0),   -- NULL = not tracked
  image_urls        TEXT[] NOT NULL DEFAULT '{}',
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  moderation_status moderation_status NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supply_products_seller_idx ON supply_products(seller_id) WHERE is_active;
CREATE INDEX supply_products_search_idx ON supply_products USING gin (to_tsvector('english', name || ' ' || coalesce(description, '')));

CREATE TABLE supply_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code           TEXT NOT NULL UNIQUE,
  buyer_id             UUID NOT NULL REFERENCES users(id),
  seller_id            UUID NOT NULL REFERENCES parts_sellers(id),
  job_id               UUID REFERENCES jobs(id),        -- optional: technician buying parts for a job
  status               TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                         'pending_payment', 'paid', 'accepted', 'ready_for_pickup', 'dispatched',
                         'received', 'completed', 'cancelled', 'rejected', 'disputed', 'refunded')),
  fulfilment           TEXT NOT NULL CHECK (fulfilment IN ('delivery', 'pickup')),
  delivery_address     TEXT,
  subtotal_minor       BIGINT NOT NULL,
  discount_minor       BIGINT NOT NULL DEFAULT 0,
  delivery_fee_minor   BIGINT NOT NULL DEFAULT 0,
  total_minor          BIGINT NOT NULL,
  commission_bps       INTEGER NOT NULL,
  commission_minor     BIGINT NOT NULL,
  seller_net_minor     BIGINT NOT NULL,
  payment_id           UUID REFERENCES payments(id),
  note                 TEXT,
  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at              TIMESTAMPTZ,
  dispatched_at        TIMESTAMPTZ,
  received_at          TIMESTAMPTZ,
  CHECK (fulfilment = 'pickup' OR delivery_address IS NOT NULL),
  CHECK (total_minor = subtotal_minor - discount_minor + delivery_fee_minor)
);
CREATE INDEX supply_orders_buyer_idx ON supply_orders(buyer_id, created_at DESC);
CREATE INDEX supply_orders_seller_idx ON supply_orders(seller_id, status);

CREATE TABLE supply_order_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES supply_products(id),
  name              TEXT NOT NULL,                 -- snapshot at purchase
  unit              TEXT NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  list_price_minor  BIGINT NOT NULL,
  unit_price_minor  BIGINT NOT NULL,               -- after bulk / technician tier
  line_total_minor  BIGINT NOT NULL
);

CREATE TABLE supply_reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL UNIQUE REFERENCES supply_orders(id),
  buyer_id    UUID NOT NULL REFERENCES users(id),
  seller_id   UUID NOT NULL REFERENCES parts_sellers(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payments ADD COLUMN supply_order_id UUID REFERENCES supply_orders(id);
ALTER TABLE payment_splits DROP CONSTRAINT payment_splits_recipient_check;
ALTER TABLE payment_splits ADD CONSTRAINT payment_splits_recipient_check CHECK (recipient IN ('platform', 'technician', 'seller', 'customer_refund'));
ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'supplies_purchase';
ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'supplies_sale';
