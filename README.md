# HANDIWORK-DECK

A multi-sided mobile marketplace connecting **homeowners, offices and SMEs** with local
**household/office technicians** and **construction / plant-erection tradespeople**, plus
**spare-parts sellers** who advertise to both sides.

| Role | What they do |
| --- | --- |
| Customer | Post jobs (homeowner, office or SME), compare quotes, track the technician live, pay, review |
| Technician | Get verified, set services and service radius, quote on nearby jobs, share live location, get paid via split payments |
| Advertiser | Run sponsored spare-parts campaigns targeted by service category |
| Admin | Verify technicians, work escalations, review ads, refund payments |

## Repository layout

```
apps/
  api/        Node.js + Express API, PostgreSQL, BullMQ worker
  mobile/     React Native (Expo, expo-router) app for iOS and Android
packages/
  shared/     Domain rules shared by both: roles, job state machine, money maths, geo
firebase/     Firestore security rules for live location
docker-compose.yml   Local PostgreSQL + Redis
```

## Tech stack

| Concern | Choice | Where |
| --- | --- | --- |
| Mobile | React Native (Expo SDK 57, expo-router) | `apps/mobile` |
| API | Node.js / Express 5, zod validation | `apps/api/src/routes` |
| Database | PostgreSQL (SQL migrations) | `apps/api/src/db/migrations` |
| Auth | Firebase Auth ID tokens, verified server-side | `apps/api/src/middleware/auth.ts` |
| Push | Firebase Cloud Messaging | `apps/api/src/services/notifications/push.ts` |
| Live location | Firestore, device to device, access granted per job by the API | `apps/mobile/src/lib/liveLocation.ts`, `firebase/firestore.rules` |
| Payments | Provider-agnostic interface: Stripe Connect, Paystack and Flutterwave split payments | `apps/api/src/services/payments` |
| Messaging | WhatsApp Business Cloud API relay through one platform-owned number | `apps/api/src/services/messaging` |
| Jobs / escalations | BullMQ on Redis | `apps/api/src/queues`, `apps/api/src/worker.ts` |
| File storage | AWS S3 (presigned PUT) or Cloudinary (signed upload) | `apps/api/src/services/storage` |

## How the pieces fit

### Job lifecycle

The state machine lives in `packages/shared/src/jobs.ts`. Both the API and the app use it,
and it also records which role may make each transition:

```
open ──quote──▶ quoted ──customer accepts──▶ assigned ──▶ en_route ──▶ in_progress ──▶ completed ──webhook──▶ paid
  └──────────────┴──────────────┴─▶ cancelled        any active state ─▶ disputed (admin resolves)
```

### Matching and escalation (BullMQ)

1. When a job is posted, verified and available technicians offering that category within
   the job's match radius get a push notification.
2. `no_quote_widen` (default 15 min): if there are still no quotes, the radius is multiplied
   by `MATCH_WIDEN_RADIUS_FACTOR`. Only the newly reachable technicians are notified.
3. `no_quote_admin` (default 60 min): admins are alerted and the customer is reassured.
4. `no_show` (scheduled time + 30 min): fires if an assigned technician hasn't gone en route.

Every step checks the job's current state again before acting, so a job that has moved on
makes the escalation a no-op. Queue job IDs are deterministic, so the same escalation
can't be scheduled twice.

### Payments (split at source)

The rest of the codebase only calls the `PaymentProvider` interface (`onboardPayee`,
`createSplitPayment`, `parseWebhook`, `refund`):

- **Stripe Connect:** Express accounts and a hosted Checkout Session with a destination
  charge. `application_fee_amount` is the platform fee.
- **Paystack:** subaccounts. `transaction_charge` is the platform's flat cut, with
  `bearer: subaccount`.
- **Flutterwave:** subaccounts with a `flat_subaccount` charge. The API is called in major
  units. Successful webhooks are re-verified through `/transactions/:id/verify`.
- **Mock:** for development and tests. It is refused in production.

`PAYMENT_CURRENCY_ROUTES` picks the provider when a technician onboards their payouts (for
example NGN → Paystack, KES → Flutterwave, USD → Stripe). The payment for a job always goes
through the provider that holds the technician's payee account. Money is stored as integer
minor units. Webhooks are signature-verified and idempotent (`webhook_events`), and an
underpayment is rejected.

### WhatsApp relay

Customers and technicians message the **platform's** WhatsApp number. Neither side sees the
other's number.

- The sender is identified by their phone number. The conversation is their only open job,
  or the one named by a leading `#HW-XXXXX` reference. If several jobs could match, the
  sender is asked to add the reference.
- Messages are forwarded as `[#HW-7K2QD] Customer (Ada): …`, stored, and deduplicated on
  WhatsApp's message ID.
- The app opens a `wa.me` deep link with the job reference already filled in.
- The conversation is created when a quote is accepted and closed when the job is paid or
  cancelled.

## Getting started

Requirements: Node 20.19+ (22 recommended) and Docker (or local PostgreSQL 16 and Redis 7).

```bash
npm install
docker compose up -d                 # postgres + redis
cp apps/api/.env.example apps/api/.env
cp apps/mobile/.env.example apps/mobile/.env

npm run db:migrate
npm run db:seed                      # service categories for both segments

npm run dev:api                      # http://localhost:4000
npm run dev:worker                   # BullMQ worker: escalations + push
npm run dev:mobile                   # Expo dev server
```

For local development without Firebase, leave `EXPO_PUBLIC_FIREBASE_*` empty and run the
API with `AUTH_MODE=dev`. The app then shows a **developer sign-in**, which sends
`Bearer dev:<uid>[:<+phone>]` tokens. The API refuses these tokens when
`NODE_ENV=production`.

To make someone an admin: `npm run db:make-admin --workspace @handiwork/api -- someone@example.com`.

### Tests

```bash
npm run typecheck
npm test          # shared unit tests, provider unit tests, API integration tests
```

The API integration tests need a PostgreSQL database
(`TEST_DATABASE_URL`, default `postgres://handiwork:handiwork@localhost:5432/handiwork_test`).
They drop and recreate the schema, then run the whole marketplace flow end to end: register,
verify, post, escalate, quote, accept, WhatsApp relay, status changes, split payment and
webhook, review, and an ad campaign. If PostgreSQL can't be reached, the tests are skipped
with a warning.

## API overview (`/v1`)

| Area | Endpoints |
| --- | --- |
| Account | `POST /auth/register`, `GET/PATCH /me`, `POST /me/push-tokens`, `GET /categories` |
| Technicians | `PUT /technicians/me`, `PUT /technicians/me/services`, `POST /technicians/me/payout-account`, `POST /technicians/me/portfolio`, `GET /technicians/:id` |
| Jobs | `POST /jobs`, `GET /jobs[?feed=nearby]`, `GET /jobs/:id`, `POST /jobs/:id/quotes`, `POST /jobs/:id/quotes/:quoteId/accept`, `POST /jobs/:id/status`, `POST /jobs/:id/review` |
| Payments | `POST /jobs/:id/payments`, `POST /webhooks/payments/:provider` |
| WhatsApp | `GET/POST /webhooks/whatsapp` |
| Files | `POST /uploads`, `POST /uploads/:id/complete` |
| Ads | `POST /ads`, `GET /ads/mine`, `POST /ads/:id/status`, `GET /ads/placements`, `POST /ads/:id/click` |
| Admin | `GET /admin/stats`, `GET /admin/technicians`, `POST /admin/technicians/:id/verification`, `POST /admin/users/:id/active`, `GET /admin/escalations`, `POST /admin/escalations/:id/resolve`, `GET /admin/ads`, `POST /admin/ads/:id/review`, `POST /admin/payments/:id/refund` |

## Deployment notes

- **API:** `docker build -f apps/api/Dockerfile -t handiwork-api .` builds the image. It runs
  migrations and then starts the server. Run `node dist/worker.js` from the same image as a
  separate process for the queue worker.
- **Mobile:** EAS profiles are in `apps/mobile/eas.json`. Use `eas build -p ios|android` and
  `eas submit`. Push notifications need the FCM / APNs credentials configured in EAS.
- **Firebase:** deploy the rules with `firebase deploy --only firestore:rules` from
  `firebase/`.
- **WhatsApp:** point the Meta webhook to `/v1/webhooks/whatsapp` and set
  `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`. Messages the business starts outside
  the 24-hour window need approved templates (`sendTemplate`).

## Not built yet

- **Phone-number (OTP) sign-in:** it needs `@react-native-firebase/auth` in an Expo dev
  build. Email/password works in Expo Go.
- **Escrow:** funds are split when the customer pays, after the job is marked completed.
  Holding funds until the customer confirms would mean moving Stripe to separate charges
  and transfers and using delayed settlement on Paystack/Flutterwave.
- **Ad billing:** impressions and clicks are counted, but `spent_minor` isn't charged yet.
- **Search at scale:** matching uses haversine in SQL. Move to PostGIS with a GiST index when
  volume calls for it.
