-- Section 2: admin-managed service taxonomy.
-- Section 3: discovery, booking modes, itemized quotes & counters, masked chat,
--            payment methods & wallet, mandatory multi-category reviews.

-- ================================================================ taxonomy
ALTER TABLE service_categories
  ADD COLUMN description TEXT,
  ADD COLUMN is_other    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TRIGGER service_categories_touch BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Launch taxonomy (mirrors DEFAULT_TAXONOMY in packages/shared/src/taxonomy.ts).
-- After this migration, categories are managed by admins in the database.
INSERT INTO service_categories (slug, name, segment, icon, sort_order, is_other) VALUES
  ('plumbing', 'Plumbing', 'household_office'::service_segment, 'water', 0, false),
  ('electrical', 'Electrical', 'household_office'::service_segment, 'flash', 1, false),
  ('hvac-ac-repair', 'HVAC / AC repair', 'household_office'::service_segment, 'snow', 2, false),
  ('appliance-repair', 'Appliance repair', 'household_office'::service_segment, 'tv', 3, false),
  ('generator-repair', 'Generator repair / servicing', 'household_office'::service_segment, 'battery-charging', 4, false),
  ('carpentry', 'Carpentry & furniture repair / assembly', 'household_office'::service_segment, 'hammer', 5, false),
  ('painting', 'Painting & wall finishing', 'household_office'::service_segment, 'color-palette', 6, false),
  ('masonry-tiling-pop', 'Masonry / tiling / POP', 'household_office'::service_segment, 'grid', 7, false),
  ('locksmith', 'Locksmith & security fittings', 'household_office'::service_segment, 'key', 8, false),
  ('pest-control', 'Pest control & fumigation', 'household_office'::service_segment, 'bug', 9, false),
  ('cleaning', 'Cleaning services', 'household_office'::service_segment, 'sparkles', 10, false),
  ('cctv-security', 'CCTV / alarm / security installation', 'household_office'::service_segment, 'videocam', 11, false),
  ('it-networking', 'Networking & IT support', 'household_office'::service_segment, 'wifi', 12, false),
  ('phone-repair', 'Phone repair', 'household_office'::service_segment, 'phone-portrait', 13, false),
  ('watch-repair', 'Wrist watch repair', 'household_office'::service_segment, 'watch', 14, false),
  ('electronics-repair', 'Electronics repair', 'household_office'::service_segment, 'hardware-chip', 15, false),
  ('electrical-repair', 'Electrical repair', 'household_office'::service_segment, 'flash-outline', 16, false),
  ('furniture-repair', 'Furniture repair', 'household_office'::service_segment, 'bed', 17, false),
  ('cloth-repair', 'Cloth repair', 'household_office'::service_segment, 'shirt', 18, false),
  ('makeup', 'Facial make-up', 'household_office'::service_segment, 'happy', 19, false),
  ('hairdresser', 'Hair dresser', 'household_office'::service_segment, 'cut', 20, false),
  ('nails', 'Nail technician', 'household_office'::service_segment, 'hand-left', 21, false),
  ('dj', 'DJ', 'household_office'::service_segment, 'musical-notes', 22, false),
  ('canopy-chair-rental', 'Canopy / chair rental', 'household_office'::service_segment, 'umbrella', 23, false),
  ('photographer', 'Photographer', 'household_office'::service_segment, 'camera', 24, false),
  ('tailor', 'Tailor', 'household_office'::service_segment, 'shirt-outline', 25, false),
  ('table-sachet-water', 'Table / sachet water supply', 'household_office'::service_segment, 'water-outline', 26, false),
  ('borehole-repair', 'Borehole repair', 'household_office'::service_segment, 'water', 27, false),
  ('therapist', 'Therapist', 'household_office'::service_segment, 'heart', 28, false),
  ('nurse', 'Nurse', 'household_office'::service_segment, 'medkit', 29, false),
  ('cleaner', 'Cleaner', 'household_office'::service_segment, 'sparkles-outline', 30, false),
  ('dry-cleaner', 'Dry cleaner', 'household_office'::service_segment, 'shirt', 31, false),
  ('car-wash', 'Car wash', 'household_office'::service_segment, 'car-sport', 32, false),
  ('driver', 'Driver', 'household_office'::service_segment, 'car', 33, false),
  ('event-planner', 'Event planner', 'household_office'::service_segment, 'calendar', 34, false),
  ('party-decorator', 'Party decorator', 'household_office'::service_segment, 'balloon', 35, false),
  ('butcher', 'Butcher', 'household_office'::service_segment, 'restaurant', 36, false),
  ('party-pot', 'Party pot / cooking pots', 'household_office'::service_segment, 'flame', 37, false),
  ('bartender', 'Bartender', 'household_office'::service_segment, 'wine', 38, false),
  ('party-speaker', 'Party speaker rental', 'household_office'::service_segment, 'volume-high', 39, false),
  ('printing', 'Printing', 'household_office'::service_segment, 'print', 40, false),
  ('aluminum-repair', 'Aluminum repair', 'household_office'::service_segment, 'grid-outline', 41, false),
  ('shoe-maker', 'Shoe maker', 'household_office'::service_segment, 'footsteps', 42, false),
  ('waste-management', 'Waste management', 'household_office'::service_segment, 'trash', 43, false),
  ('vulcanizer', 'Vulcanizer', 'household_office'::service_segment, 'disc', 44, false),
  ('auto-mechanic', 'Auto mechanic', 'household_office'::service_segment, 'construct', 45, false),
  ('auto-electrician', 'Auto electrician', 'household_office'::service_segment, 'car-outline', 46, false),
  ('barber', 'Barber', 'household_office'::service_segment, 'cut-outline', 47, false),
  ('spa', 'Spa', 'household_office'::service_segment, 'flower', 48, false),
  ('panel-beater', 'Auto panel beater', 'household_office'::service_segment, 'car-sport-outline', 49, false),
  ('household-security', 'Household security', 'household_office'::service_segment, 'shield-checkmark', 50, false),
  ('upholstery', 'Upholstery repair', 'household_office'::service_segment, 'bed-outline', 51, false),
  ('food-vendor', 'Food vendor', 'household_office'::service_segment, 'fast-food', 52, false),
  ('interior-designer', 'Interior designer', 'household_office'::service_segment, 'color-wand', 53, false),
  ('cook-chef', 'Cook / chef', 'household_office'::service_segment, 'restaurant-outline', 54, false),
  ('computer-office-equipment', 'Computer / office equipment repair', 'household_office'::service_segment, 'desktop', 55, false),
  ('solar-inverter', 'Solar & inverter installation / maintenance', 'household_office'::service_segment, 'sunny', 56, false),
  ('interior-furniture-installation', 'Interior / furniture installation', 'household_office'::service_segment, 'easel', 57, false),
  ('landscaping', 'Landscaping & gardening', 'household_office'::service_segment, 'leaf', 58, false),
  ('fire-safety', 'Fire safety equipment servicing', 'household_office'::service_segment, 'bonfire', 59, false),
  ('other-household', 'Other / custom service', 'household_office'::service_segment, 'add-circle', 60, true),
  ('bricklaying-masonry', 'Bricklaying / masonry', 'construction_plant'::service_segment, 'cube', 61, false),
  ('iron-bending', 'Iron bending / rebar work', 'construction_plant'::service_segment, 'reorder-four', 62, false),
  ('welding-fabrication', 'Welding & fabrication', 'construction_plant'::service_segment, 'flame', 63, false),
  ('structural-carpentry', 'Structural carpentry', 'construction_plant'::service_segment, 'hammer', 64, false),
  ('scaffolding', 'Scaffolding / plant erection', 'construction_plant'::service_segment, 'business', 65, false),
  ('land-piling', 'Land piling', 'construction_plant'::service_segment, 'arrow-down-circle', 66, false),
  ('window-fixing', 'Window fixing', 'construction_plant'::service_segment, 'browsers', 67, false),
  ('tiling', 'Tiling', 'construction_plant'::service_segment, 'grid', 68, false),
  ('roofing', 'Roofing', 'construction_plant'::service_segment, 'home', 69, false),
  ('other-construction', 'Other construction trade', 'construction_plant'::service_segment, 'add-circle', 70, true)

ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name, segment = EXCLUDED.segment, icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order, is_other = EXCLUDED.is_other, is_active = true;

-- Retire pre-taxonomy development seed entries that were renamed or folded in.
UPDATE service_categories SET is_active = false
 WHERE slug IN ('ac-refrigeration', 'masonry', 'steel-erection', 'crane-plant-operator', 'borehole-drilling', 'pipefitting');

-- "Other/custom" requests: proposed by customers (when posting under "Other") or
-- technicians (for a trade that isn't listed); approved into real categories by admins.
CREATE TYPE suggestion_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TABLE category_suggestions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  segment              service_segment NOT NULL,
  note                 TEXT,
  suggested_by         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id               UUID,                            -- FK added below (jobs is altered later)
  status               suggestion_status NOT NULL DEFAULT 'pending',
  resolved_category_id INT REFERENCES service_categories(id) ON DELETE SET NULL,
  reviewed_by          UUID REFERENCES users(id),
  reviewed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX category_suggestions_pending_idx ON category_suggestions (created_at) WHERE status = 'pending';

-- ================================================================ technician profile
CREATE TYPE labor_stance AS ENUM ('accepts_labor_only', 'case_by_case', 'no_labor_only');
ALTER TABLE technician_profiles
  ADD COLUMN headline             TEXT,
  ADD COLUMN avatar_file_id       UUID REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN labor_stance         labor_stance NOT NULL DEFAULT 'case_by_case',
  ADD COLUMN instant_book_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Live position while the technician is online (discovery map). Not the per-job
  -- live tracking, which goes device-to-device through Firestore.
  ADD COLUMN live_lat             DOUBLE PRECISION,
  ADD COLUMN live_lng             DOUBLE PRECISION,
  ADD COLUMN live_at              TIMESTAMPTZ;

CREATE TABLE technician_certifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  issuer        TEXT,
  issued_on     DATE,
  expires_on    DATE,
  file_id       UUID REFERENCES files(id) ON DELETE SET NULL,
  is_verified   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX technician_certifications_tech_idx ON technician_certifications (technician_id);

-- Paid / granted priority placement in discovery (purchase flow comes with Section 16).
CREATE TABLE technician_boosts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id UUID NOT NULL REFERENCES technician_profiles(user_id) ON DELETE CASCADE,
  category_id   INT REFERENCES service_categories(id) ON DELETE CASCADE,   -- NULL = all their categories
  priority      INT NOT NULL DEFAULT 0,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ NOT NULL,
  source        TEXT NOT NULL DEFAULT 'admin',
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX technician_boosts_active_idx ON technician_boosts (ends_at, starts_at);

-- ================================================================ jobs / booking modes
CREATE TYPE booking_mode AS ENUM ('open', 'request', 'instant');
ALTER TABLE jobs
  ADD COLUMN booking_mode              booking_mode NOT NULL DEFAULT 'open',
  ADD COLUMN target_technician_id      UUID REFERENCES users(id),     -- request / instant booking
  ADD COLUMN custom_service_name       TEXT,                         -- jobs under an "Other" category
  ADD COLUMN awaiting_category_review  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN labor_only                BOOLEAN NOT NULL DEFAULT false; -- customer supplies materials
ALTER TABLE category_suggestions ADD CONSTRAINT category_suggestions_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

-- ================================================================ itemized quotes & counters
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'countered' AFTER 'pending';
CREATE TYPE quote_item_kind AS ENUM ('labor', 'material', 'transport', 'other', 'adjustment');
ALTER TABLE quotes
  ADD COLUMN labor_minor     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN materials_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN revision        INT NOT NULL DEFAULT 1,
  ADD COLUMN labor_only      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TRIGGER quotes_touch BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE quote_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id         UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  kind             quote_item_kind NOT NULL,
  description      TEXT NOT NULL,
  quantity         NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL,
  total_minor      BIGINT NOT NULL,
  position         INT NOT NULL DEFAULT 0,
  CHECK (kind = 'adjustment' OR (unit_price_minor >= 0 AND total_minor >= 0))
);
CREATE INDEX quote_items_quote_idx ON quote_items (quote_id, position);

CREATE TYPE counter_kind AS ENUM ('labor_only', 'price_challenge', 'labor_negotiation');
CREATE TYPE counter_status AS ENUM ('pending', 'accepted', 'declined', 'superseded', 'withdrawn');
CREATE TABLE quote_counters (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id             UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_revision       INT NOT NULL,
  kind                 counter_kind NOT NULL,
  proposed_total_minor BIGINT NOT NULL CHECK (proposed_total_minor > 0),
  proposed_labor_minor BIGINT,
  message              TEXT,
  status               counter_status NOT NULL DEFAULT 'pending',
  created_by           UUID NOT NULL REFERENCES users(id),
  responded_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one open counter per quote.
CREATE UNIQUE INDEX quote_counters_one_pending ON quote_counters (quote_id) WHERE status = 'pending';

-- ================================================================ masked chat
-- Conversations are now per (job, technician) so customers can talk to technicians
-- before approving a quote. Contact details are masked until approval.
ALTER TABLE conversations DROP CONSTRAINT conversations_job_id_key;
ALTER TABLE conversations ADD CONSTRAINT conversations_job_technician_key UNIQUE (job_id, technician_id);
ALTER TABLE messages
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp',   -- whatsapp | app
  ADD COLUMN masked  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ALTER COLUMN channel SET DEFAULT 'app';

-- ================================================================ reviews
ALTER TABLE reviews
  ADD COLUMN scores  JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN overall NUMERIC(3,2);
UPDATE reviews SET overall = rating WHERE overall IS NULL;
ALTER TABLE reviews ALTER COLUMN overall SET NOT NULL;

-- ================================================================ payments & wallet
ALTER TYPE payment_provider ADD VALUE IF NOT EXISTS 'wallet';
CREATE TYPE payment_method AS ENUM ('card', 'bank_transfer', 'ussd', 'wallet');
CREATE TYPE payment_purpose AS ENUM ('job', 'wallet_topup');
-- split: gateway splits at source to the technician's payee account
-- platform_collect: platform collects in full, technician's share is credited to their wallet
-- wallet: paid from the customer's wallet balance
CREATE TYPE payment_settlement AS ENUM ('split', 'platform_collect', 'wallet');
ALTER TABLE payments
  ALTER COLUMN job_id DROP NOT NULL,
  ALTER COLUMN payee_id DROP NOT NULL,
  ADD COLUMN purpose    payment_purpose NOT NULL DEFAULT 'job',
  ADD COLUMN method     payment_method NOT NULL DEFAULT 'card',
  ADD COLUMN settlement payment_settlement NOT NULL DEFAULT 'split',
  ADD CONSTRAINT payments_purpose_shape CHECK (
    (purpose = 'job' AND job_id IS NOT NULL AND payee_id IS NOT NULL) OR (purpose = 'wallet_topup' AND job_id IS NULL)
  );

CREATE TABLE wallets (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency      CHAR(3) NOT NULL,
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, currency)
);
CREATE TYPE wallet_entry_kind AS ENUM ('topup', 'job_payment', 'job_earning', 'refund', 'withdrawal', 'adjustment');
CREATE TABLE wallet_ledger (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency     CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL,              -- signed: credit > 0, debit < 0
  kind         wallet_entry_kind NOT NULL,
  payment_id   UUID REFERENCES payments(id),
  job_id       UUID REFERENCES jobs(id),
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A payment can move money into/out of a given wallet only once per kind (webhook retries).
CREATE UNIQUE INDEX wallet_ledger_payment_once ON wallet_ledger (payment_id, user_id, kind) WHERE payment_id IS NOT NULL;
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (user_id, created_at DESC);

-- ================================================================ performance inputs
-- Raw track-record numbers per technician; the multiplier itself is computed in
-- packages/shared/src/performance.ts so the formula lives in one place.
CREATE VIEW technician_performance_stats AS
SELECT tp.user_id AS technician_id,
       tp.rating_avg::float8 AS rating_avg,
       tp.rating_count,
       (SELECT count(*) FROM jobs j WHERE j.technician_id = tp.user_id AND j.status IN ('completed', 'paid'))::int AS completed_jobs,
       (SELECT count(*) FROM job_status_history h
          JOIN jobs j ON j.id = h.job_id
         WHERE h.actor_id = tp.user_id AND h.to_status = 'cancelled' AND j.technician_id = tp.user_id)::int AS technician_cancellations,
       (SELECT count(DISTINCT h.job_id) FROM job_status_history h
          JOIN jobs j ON j.id = h.job_id
         WHERE j.technician_id = tp.user_id AND h.to_status = 'disputed')::int AS disputes
  FROM technician_profiles tp;
