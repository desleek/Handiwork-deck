# Handiwork-Deck

A multi-sided mobile marketplace connecting homeowners, offices and SMEs with local household/office technicians and construction / plant-erection tradespeople. Nigeria-first (NGN, Paystack + Flutterwave), with a provider-agnostic payment layer.

```
backend/   Node.js + Express API, PostgreSQL schema, BullMQ worker, BOQ file parsers
mobile/    React Native (Expo) app for iOS and Android
docs/      Decisions log and build notes
```

## What's in this first pass

**Phase 1 (core MVP, spec sections 2–11)** — built end to end in the API, with mobile screens:

| Area | Backend | Mobile |
|---|---|---|
| Admin-managed category taxonomy (71 seeded) | ✅ | Icon-first category strip |
| Icon-first discovery grid + live map, boosted "Promoted" labels, sponsored cap 1:10 | ✅ | ✅ |
| Technician profile: portfolio (max 5), reviews with category-score tags, certifications, labor-only stance, rate context | ✅ | ✅ |
| Instant booking + request booking | ✅ | ✅ |
| Itemized quotes: labor / base parts / markup % / markup amount, 20% markup cap (API-enforced), receipts above ₦50k | ✅ | Quote builder with live server preview |
| Demand Notice (cap exception) → admin review, single-invoice scope, permanent override | ✅ | ✅ |
| Customer responses: approve · labor-only counter (stance, 3-per-90-day cap, penalty, 30-day cooldown) · price challenge · labor negotiation | ✅ | ✅ |
| Price-challenge escalation timeline, standard 72h and Fast Track 24h, uniform final rule | ✅ BullMQ | ✅ |
| Verified seller registry with provisional → verified graduated trust | ✅ | Seller picker |
| Payments: card, virtual account (transfer), USSD, wallet → escrow → itemized capture → split | ✅ Paystack, Flutterwave, Stripe, mock | ✅ |
| Commission 18% labor + 20% markup, 0% on base cost (all configurable) | ✅ | Shown as separate lines |
| Mandatory 7-category review that blocks new bookings; technician → customer compliance rating; completion badge | ✅ | ✅ |
| Masked chat (contact details auto-redacted pre-payment), WhatsApp relay through one platform number | ✅ | ✅ with offline queue |
| Live location while online / en route | ✅ | ✅ background-capable, just-in-time permissions |
| Incomplete-transaction penalties: fault attribution, Tier 1/Tier 2, appeals | ✅ | Appeal form |
| Wallet ledger, standard & instant withdrawals with fee shown up front | ✅ | ✅ |
| Account deletion, content reporting, no contacts permission, no IAP | ✅ | ✅ |

**Phase 2 (sections 7a, 12, 15, 16)** — complete, shipped switched off so you can turn each on when traction justifies it:

| Area | What's there |
|---|---|
| Performance-based labor rate (7a) | Bi-weekly recalculation, tiers and cycle editable, anomalous swings held for admin review, "recalculate now", technician dashboard with next-tier thresholds |
| Advertising (12) | Admin-managed campaigns plus an advertiser self-serve API (submit → admin review → pay → live), per-day slot pricing, impression/click tracking (de-duplicated), ad revenue and CTR analytics; failures degrade to "no ads" and never touch discovery |
| Wallet bonus economics (15) | Fee schedules for Paystack and Flutterwave, a per-tier margin model, realised 90-day margin, top-up bonus preview in the app, and a warning whenever an admin saves tiers that cost more than the fees they save |
| Boosts & push alerts (16) | 3★ gate enforced at purchase, price/eligibility preview, scheduling, no overlapping boosts, abandoned checkouts released after 30 min, daily alert cap, Promote screen in the app |

Turn features on with `PUT /admin/settings/features`, e.g. `{"value": {"advertising": true, "performanceMultiplier": true, "boosts": true, "walletBonus": true, "construction": false, "supplies": false}}`. Structured settings (tiers, timelines, fee schedules) are validated before they're saved.

**Phase 3 (sections 13, 17)** — complete, also behind feature flags:

| Area | What's there |
|---|---|
| Construction & plant erection (17) | Site consultation with admin fee bands per trade, paid before the visit, refunded on technician no-show (disputed if they say they came), released once the BOQ is delivered or 48h after the visit. BOQ builder plus Excel/CSV/Word/PDF import with per-line flags and a mandatory review step. Line-level negotiation, rejection, and milestone payments funded one at a time with commission per milestone. Admin parse-error queue, consultation and milestone dispute resolution, and construction analytics |
| Supplies marketplace (13) | Storefronts for verified sellers, products with bulk tiers and technician-only discounts, one-seller carts, delivery or pickup, escrowed payment released on receipt (or auto after 3 days), seller reviews, seller payouts via wallet withdrawals, and a seller mode in the app. Admin greenlight check against traction milestones before the feature can be switched on |

**Not built yet:** the admin web panel UI. Every admin function (sections 12–19) exists as an API under `/admin/*`, but there's no web front end for it.

## Run it locally

Requirements: Node 22.18+, Docker (for Postgres + Redis), and for the app, Xcode and/or Android Studio.

### Backend

```bash
docker compose up -d                 # Postgres 16 + Redis 7
cd backend
cp .env.example .env                 # AUTH_MODE=dev and PAYMENTS_ENABLE_MOCK=true work out of the box
npm install
npm run migrate && npm run seed      # schema + 71 categories + a dev admin user
npm run dev                          # API on :4000
npm run worker                       # in a second terminal: escalations, scans, payouts
npm test                             # pricing / rules engine tests
```

TypeScript runs natively on Node 22.18+ (type stripping), so there's no build step. `npm run typecheck` runs `tsc`.

In dev mode, send `x-dev-user-id: <uuid>` instead of a Firebase token. The seeded admin is `00000000-0000-0000-0000-000000000001`. A new UUID goes through `/me/register`. Mock payments complete with `POST /payments/:id/mock-complete`.

### Mobile

```bash
cd mobile
npm install
npx expo install --fix               # aligns versions to the Expo SDK you have
EXPO_PUBLIC_AUTH_MODE=dev EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npx expo run:android   # or run:ios
```

The app uses native modules (Firebase, maps, background location), so it runs in a development build, not Expo Go. For production, add `google-services.json` and `GoogleService-Info.plist` from your Firebase project, then `eas build`. Test on physical devices via TestFlight and the Play internal testing track before submitting.

## Key design choices

- **Money** is integer minor units (kobo) everywhere; **percentages** are basis points. No floating-point money.
- **Every business rule** in the spec lives in `backend/src/domain/settings.ts` with its default, overridable per key from `/admin/settings` and audit-logged.
- **Pricing rules are enforced in one engine** (`backend/src/domain/pricing.ts`) used by the API and by the app's live quote preview, so the UI can never diverge from what the API accepts.
- **Quotes freeze** the multiplier, cap and commission rates at submission; later changes only affect future quotes.
- **Every job always has an "action required from" party** (`jobs.action_required_from`), updated on every transition. Section 18 fault attribution reads it directly.
- **Escrow is platform-held:** all channels settle into a held payment; on confirmation it's split into ledger lines (technician wallet + platform revenue). Technicians withdraw from the wallet.
- **The ads module is isolated:** no core table references it, and turning it off returns empty Deals and no sponsored slots.

See [docs/DECISIONS.md](docs/DECISIONS.md) for the open questions from Section 22 and the defaults chosen.
