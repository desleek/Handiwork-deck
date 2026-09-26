# HANDIWORK-DECK

A multi-sided mobile marketplace connecting **homeowners, offices and SMEs** with local
**household/office technicians** and **construction / plant-erection tradespeople**, plus
**spare-parts sellers** who advertise to both sides.

| Role | What they do |
| --- | --- |
| Customer | Post jobs (homeowner, office or SME), compare quotes, track the technician live, pay, review |
| Technician | Get verified, set services and service radius, quote on nearby jobs, share live location, get paid via split payments |
| Advertiser | Run sponsored spare-parts campaigns targeted by service category |
| Admin | Manage the service taxonomy, verify technicians, work escalations, review ads, refund payments |

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

### Service taxonomy (Section 2)

Categories live in the database, not in code. Migration 002 loads the launch list: 61
**Household & Office Technical Support** categories and 10 **Construction & Plant
Erection** categories. The list is mirrored in `packages/shared/src/taxonomy.ts`. After
that, admins manage categories in the app's **Categories** tab or through
`/admin/categories`: they can add, rename, re-icon, move between supercategories and
deactivate. A deactivated category disappears from discovery and can't take new jobs.
Existing jobs keep it.

Each supercategory has one **"Other / custom"** entry:

- A customer who posts under it has to name the service. The job is held
  (`awaiting_category_review`) and a suggestion is filed.
- An admin then approves it as a new category or files it under an existing one. The job
  moves into that category and technicians are notified.
- If the admin rejects it, the job goes out under "Other".
- Technicians can also suggest a trade that isn't listed. On approval it is added to their
  profile.

### Customer flow (Section 3)

- **Discovery (`GET /discover`):** returns the cards for the app's main browsing screen.
  Each card has a photo, category icon, rating, starting price, distance and a live dot.
  - You can filter by supercategory or category, by distance from the customer, and by
    instant book.
  - **Boosted** technicians come back in a separate `boosted` list. The app shows them
    above the organic results with a **Promoted** label.
  - Organic results are ranked by performance multiplier × rating × proximity.
  - Live positions come from an "online" heartbeat that technicians send
    (`PUT /technicians/me/presence`). A position shows only if it is less than 15 minutes
    old, and it is rounded to about 100 m.
- **Profile (`GET /technicians/:id`):**
  - Up to 5 portfolio images, enforced on upload.
  - Reviews with category-score tags, plus the average for each category.
  - Certifications, with verified and expired flags.
  - The labor-only declaration for each service, and the date it was made.
  - The **performance multiplier** (the Section 7a labor rate adjustment) with its star
    tier. Standard rates shown already include it.
- **Booking modes:**
  - `open` posts the job to everyone nearby.
  - `request` sends it to one technician. If they don't respond, the escalation opens it
    to the whole marketplace.
  - `instant` books the technician straight away at their listed starting price. The
    technician has to switch this on.
- **Masked chat:** there is one thread per job and technician. In-app messages and the
  WhatsApp relay land in the same thread. Phone numbers, emails, `wa.me`/Telegram links
  and @handles are replaced with `[contact hidden]` until that technician's quote is
  approved.
- **Itemized quotes:** each line is labor, material, transport or other. Technicians can
  revise a quote, and each revision gets a new number. The customer can:
  - **approve** the quote as it is,
  - send a **labor-only** request, a **parts price challenge** or a **labor
    negotiation**. Section 6 below describes each one.

  Only one negotiation can be open on a quote at a time.
- **Payment methods:** card, bank transfer to a one-time virtual account, USSD, and the
  in-app **wallet**. The customer can choose between Paystack and Flutterwave when both
  support the method.
  - If the gateway is the one where the technician holds their payout account, the money
    is split at source.
  - Otherwise the platform collects the payment and credits the technician's share to
    their wallet.
  - Wallet payments settle instantly. The wallet can be topped up through any gateway.
- **Mandatory reviews:** see Section 7. Until the customer has reviewed every paid job,
  `POST /jobs` returns `409 review_required`.

### Technician flow (Section 4)

- **Onboarding checklist** (`GET /technicians/me/onboarding`). The required steps are:
  upload an ID or certification, choose services with a labor-only declaration for each,
  set a base location and coverage radius, and set weekly availability. Portfolio (max 5)
  and payouts are optional.
- **Labor-only declarations** are made per category ("Accept" or "Decline from
  inception"). They are permanent unless switched, and a switch is allowed once every
  `labor_only_cooldown_days` (default 30). The declarations are stored in an append-only
  log, so dropping and re-adding a service doesn't reset the cooldown.
- **Availability calendar:** weekly hours per day, a time zone, and time off.
  `technician_available_at()` in SQL gates matching, instant booking and the "off hours"
  label on discovery cards.
- **Job requests:** a technician can accept or decline a booking request (declining sends
  it to the marketplace straight away), decline an instant booking (the job goes from
  `assigned` back to `open`), or dismiss a job from their feed.
- **Earnings dashboard** (`GET /technicians/me/earnings`) shows:
  - gross, commission and net earnings, split into labor, parts reimbursed and markup;
  - work still in progress and the wallet balance;
  - the performance multiplier (Section 7a): the current star tier and labor %, the rolling
    rating behind it, every tier's threshold, the rating needed for the next tier, and the
    date of the next recalculation.
- **Promotions:** visibility boosts and priority job alerts, which widen a technician's
  alert radius (2× reach). They are paid from the wallet. Prices and eligibility rules are
  admin settings (`promotions`); eligibility requires a verified account, a tier that
  isn't under review, a rating floor, and no open disputes.
- **Payouts:** standard payouts are free and go out in the next daily batch. Instant
  payouts are sent immediately for a fee. They go through Paystack transfers, Flutterwave
  transfers or a Stripe transfer (plus an instant payout for Stripe). If a transfer fails,
  the amount and fee go back to the wallet.
- **Customer ratings:** see Section 7.

### Pricing model (Section 5)

- Every quote and invoice lists **Labor** and **Parts/Materials** separately. Each part
  line shows its base cost, markup % and markup amount. A quote must have at least one
  labor line.
- **Markup cap:** default 20% (`markup_cap_bps`). The API rejects anything above it
  (`422 markup_cap_exceeded`) unless a Demand Notice is attached. The quote builder blocks
  it in the app too.
- **Receipts:** any part whose base cost is at or above the per-currency threshold (default
  ₦50k / $50, `receipt_threshold_minor`) needs a receipt before the job can be marked
  completed (`409 receipts_required`).
- **Commission:** 18% of labor plus 20% of markup, and 0% of the base part cost
  (`commission`). The rates are copied onto the job when a quote is accepted, so changing
  them later doesn't re-price work that's already agreed. Negotiated reductions come out of
  labor first, then markup, and never out of part cost.
- Admins change all of these in the app under **Profile → Pricing & platform settings**,
  or with `GET/PUT /admin/settings/:key`.

### Demand Notice — markup cap exceptions (Section 5a)

- A part line above the cap carries a `capException` with a reason and evidence files. The
  quote is saved as `pending_exception` and the customer is told it's under review. They
  can't approve or counter it until the review is done.
- Admins handle cases in the **Demand Notices** tab. Approving applies the markup to that
  quote revision only. Declining cuts the line back to the cap. Either way the admin can
  add a note. A **permanent per-technician cap override** is a separate action.
- Every request, evidence file and decision is logged in the job's audit trail
  (`GET /jobs/:id/audit`, and the Audit trail screen in the app).

### Customer quote responses (Section 6)

1. **Approve as-is.**
2. **Labor-only request.** Only offered when the technician declared "Accept" for that
   category. Each request records the declaration in force when it was made, so a later
   switch never changes past history.
   - If a technician declines a request in a category they accepted, it counts as a
     rejection for that category.
   - More than `labor_only_rejections.cap` rejections (default 3) within `windowDays`
     (default 90) adds a rating penalty (`penaltyPoints`) and opens a technician flag.
   - Switching the declaration doesn't clear earlier rejections.
   - A category declared "Decline from inception" never receives these requests, so it
     never builds up a penalty.
3. **Parts price challenge** (before the job starts, `POST …/price-challenges`).
   - Evidence is a `price_evidence` upload that names its seller, either from the
     Section 10 registry or as a new seller. Evidence from flagged or removed sellers is
     rejected at upload. Evidence from an unlisted seller is reviewed by an admin before
     the technician is asked.
   - The technician can **match** the price (the new base cost applies and their disclosed
     markup % is kept), **explain** the difference, or **hold firm**.
   - If they don't respond, BullMQ runs the timeline in `packages/shared/src/priceChallenge.ts`:

     | | Standard | Fast Track (urgent, chosen by the customer) |
     |---|---|---|
     | Response expected | 6h | 2h |
     | Reminders | every 4h, hours 6–30 | hourly to hour 8 |
     | Admin escalation, plus email and WhatsApp to the technician | 48h | 8h |
     | Automatic outcome | 72h | 24h |

   - The automatic outcome is the same for every case (`price_challenge.timeoutAction`).
     By default the customer's evidenced prices are applied. An admin can switch this
     globally to auto-cancel, which tells the customer to send a labor-only request
     instead.
   - Fast Track cases are marked urgent for the technician and appear first in the
     admin queue.
4. **Labor cost negotiation.** The customer proposes a lower labor cost for this job
   only. The technician's standard labor already includes their performance adjustment.
   - The technician can accept, decline (keeping the standard rate), or counter with an
     amount between the proposal and the standard rate. The customer then accepts or
     declines that counter.
   - The published rate never changes. Every rate and outcome is written to the job's
     audit trail.

### Dual ratings (Section 7)

- **Customer → technician** (mandatory): scores for competence, punctuality,
  professionalism, courtesy, delivery timeline, transparency/pricing fairness, and quality
  of work, plus a written review. Public reviews show tags for their category scores. New
  bookings are blocked until the review is submitted.
- **Technician → customer** (optional): on site as scheduled, granted access, paid
  through the platform, and respectful conduct. Technicians see the customer's average
  on feed cards and job pages before they accept.
- **Platform completion badge** for customers: at least 3 paid jobs, with at least 90% of
  the jobs they hired someone for paid in full through the platform (`completion_badge`).
- Both kinds of rating are only accepted on bookings that were completed and paid through
  the platform with a verified technician.

### Performance-based labor rate (Section 7a)

- The **rolling rating** is a weighted-recent average (half-life `rating.halfLifeDays`,
  default 180) minus any active penalties. The same number is the public rating.
- On a fixed cycle (`rate_adjustment.cycleDays`, default 14, checked by an hourly worker
  job) the rating maps to a tier. The tier's percentage applies to labor only:

  | Tier | Rating | Labor rate |
  |---|---|---|
  | 5★ | 4.5 or more | +10% |
  | 4★ | 3.5 to 4.49 | +5% |
  | 3★ | 2.5 to 3.49 | no change |
  | 2★ | 1.5 to 2.49 | −5% |
  | 1★ | below 1.5 | −10% |

- Each quote records the adjustment in force when it is first submitted, and it appears
  as a disclosed "Performance rate adjustment" line. Revisions and quotes that are already
  approved keep their original rate.
- If a tier drops only because of the most recent review, the change is held for admin
  review. Admins can also flag a change that was already applied, override a technician's
  rate, and edit the tiers, percentages and cycle length.
- The same rolling rating decides boost eligibility.

### Masked communication (Section 8)

- **In-app chat is the primary channel.** There is one thread per job and technician. Each
  message is stored twice: the masked text the parties see, and the unmasked original.
  Admins can read the originals as dispute evidence (`GET /admin/jobs/:id/messages`, and
  the "Full chat log" screen).
- **WhatsApp is the technicians' fallback.** Important technician notifications also go out
  from the central WhatsApp number (the `whatsapp` flag on a notification). These cover:
  customer messages, booking requests, being hired, quote counters, and price challenges.
  - Inside WhatsApp's 24-hour window this is plain text. Outside it, the approved
    `technician_notification` template is used.
  - Replies sent to that number go into the job's in-app thread. The technician is
    identified by their phone number, and a leading `#HW-XXXXX` picks the job. The
    customer is then notified in the app.
  - Customers who message the number are asked to use the app instead. The customer's
    number is never involved.
- **Real contact details** come from `GET /jobs/:id/contact`, and only once the job is
  approved (a quote has been accepted). Before that the endpoint returns
  `403 contact_locked` and phone numbers or emails in messages are masked. Every release
  is written to the audit trail.

### Live location (Section 9)

- **Discovery map:** while a technician is online, their app sends a heartbeat every
  minute. Positions older than 15 minutes aren't shown, and they're rounded to about
  100 m.
- **En route:** the technician's app sends its position (`PUT /jobs/:id/location`). The
  customer sees the position, the distance and an ETA (`GET /jobs/:id/tracking`,
  `estimateEtaMinutes`).
  - The ETA uses straight-line distance × 1.3 at the technician's reported speed, or
    25 km/h when they're stopped (`tracking` setting).
  - When Firebase is configured, positions are also mirrored to Firestore so the map
    updates instantly.
- **Only while online:** positions are only accepted while the technician is online and
  the job is en route. Going offline or arriving deletes the stored position.
- **Permission disclosures:**
  - The app shows its own disclosure before the OS permission prompt, and the acceptance
    is recorded with `POST /me/location-disclosure`.
  - Only foreground ("when in use") location is requested. The iOS "Always" strings are
    removed, and Android's `ACCESS_BACKGROUND_LOCATION` is blocked in `app.json`.

### Spare-parts seller registry (Section 10)

Trust grows in stages: an **unlisted** seller becomes **provisional**, then **verified**.
Admins can also mark a seller **flagged**, **removed** or **merged**.

- **Seeding:** admins add sellers with a name, registration/ID, contact details and the
  categories they supply. Admin-added sellers start as verified.
- **Growing from evidence:**
  - A customer can name a seller who isn't listed. The seller is recorded as `unlisted`,
    matched to existing records by name and phone (last 10 digits).
  - The challenge then waits in `pending_review`, and the technician's clock doesn't start
    until an admin decides.
  - If the admin accepts the evidence, the seller becomes **provisional**.
  - If they reject it, the challenge closes.
- **Clean approvals:** each challenge settled in favour of a seller's evidence counts as a
  clean approval for that seller. This covers a technician match, an admin approval, or
  an automatic approval. With `seller_registry.autoVerifyEnabled` on (off by default),
  provisional sellers become verified after `cleanApprovalsRequired` clean approvals.
- **Admin tools:** add and edit sellers, upgrade provisional sellers to verified, flag or
  remove sellers (with a reason), and merge duplicates. A merge moves the evidence files and
  clean-approval counts onto the record being kept, and citing the old record automatically
  resolves to it. The same screen holds the auto-verification settings.

## Getting started

Requirements: Node 20.19+ (22 recommended) and Docker (or local PostgreSQL 16 and Redis 7).

```bash
npm install
docker compose up -d                 # postgres + redis
cp apps/api/.env.example apps/api/.env
cp apps/mobile/.env.example apps/mobile/.env

npm run db:migrate                   # schema + the launch service taxonomy

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
| Account | `POST /auth/register`, `GET/PATCH /me`, `POST /me/push-tokens`, `GET /me/pending-reviews` |
| Taxonomy | `GET /categories`, `POST /categories/suggestions` |
| Discovery | `GET /discover` |
| Technician (self) | `GET /technicians/me/onboarding`, `GET/PUT /technicians/me/availability`, `POST/DELETE /technicians/me/time-off`, `PUT /technicians/me/services/:categoryId/labor-only`, `GET /technicians/me/pricing`, `GET /technicians/me/earnings`, `GET/POST /technicians/me/promotions`, `GET /technicians/me/payouts[/quote]`, `POST /technicians/me/payouts` |
| Technicians | `PUT /technicians/me`, `PUT /technicians/me/presence`, `PUT /technicians/me/services`, `POST /technicians/me/payout-account`, `POST/DELETE /technicians/me/portfolio`, `POST/DELETE /technicians/me/certifications`, `GET /technicians/:id` |
| Jobs | `POST /jobs`, `GET /jobs[?feed=nearby]`, `GET /jobs/:id`, `POST /jobs/:id/status`, `POST /jobs/:id/review` |
| Job requests | `POST /jobs/:id/request/accept`, `POST /jobs/:id/request/decline`, `POST /jobs/:id/instant/decline`, `POST /jobs/:id/dismiss`, `GET /jobs/:id/invoice`, `GET /jobs/:id/audit`, `POST /jobs/:id/customer-rating` |
| Price challenges | `GET /sellers`, `POST /jobs/:id/quotes/:quoteId/price-challenges`, `GET /jobs/:id/price-challenges`, `POST /price-challenges/:id/respond`, `POST /price-challenges/:id/withdraw` |
| Quotes | `POST /jobs/:id/quotes`, `PUT /jobs/:id/quotes/:quoteId`, `POST …/items/:itemId/receipt`, `POST …/withdraw`, `POST …/accept`, `POST …/counter`, `POST …/counters/:counterId/respond`, `POST …/counters/:counterId/withdraw` |
| Chat & contact | `GET /jobs/:id/conversations`, `GET/POST /jobs/:id/messages`, `GET /jobs/:id/contact` |
| Tracking | `POST /me/location-disclosure`, `PUT /jobs/:id/location`, `GET /jobs/:id/tracking` |
| Payments | `GET /payments/options`, `POST /jobs/:id/payments`, `GET /wallet`, `POST /wallet/topups`, `POST /webhooks/payments/:provider` |
| WhatsApp | `GET/POST /webhooks/whatsapp` |
| Files | `POST /uploads`, `POST /uploads/:id/complete` |
| Ads | `POST /ads`, `GET /ads/mine`, `POST /ads/:id/status`, `GET /ads/placements`, `POST /ads/:id/click` |
| Admin | `GET /admin/jobs/:id/messages`, `GET /admin/price-challenges`, `POST /admin/price-challenges/:id/review-evidence`, `POST /admin/price-challenges/:id/resolve`, `GET/POST/PATCH /admin/sellers`, `POST /admin/sellers/:id/status`, `POST /admin/sellers/:id/merge`, `GET /admin/flags`, `POST /admin/flags/:id/resolve`, `GET /admin/rate-adjustments`, `POST /admin/rate-adjustments/:id/decide`, `POST /admin/rate-adjustments/:id/flag`, `PUT /admin/technicians/:id/rate-override`, `POST /admin/technicians/:id/recalculate-rate`, `POST /admin/technicians/:id/rating-penalties`, `GET /admin/cap-exceptions`, `POST /admin/cap-exceptions/:id/decide`, `PUT /admin/technicians/:id/markup-cap`, `GET /admin/settings`, `PUT /admin/settings/:key`, `GET/POST/PATCH /admin/categories`, `GET /admin/category-suggestions`, `POST …/:id/approve`, `POST …/:id/reject`, `GET/POST/DELETE /admin/boosts`, `POST /admin/certifications/:id/verify`, `GET /admin/stats`, `GET /admin/technicians`, `POST /admin/technicians/:id/verification`, `POST /admin/users/:id/active`, `GET /admin/escalations`, `POST /admin/escalations/:id/resolve`, `GET /admin/ads`, `POST /admin/ads/:id/review`, `POST /admin/payments/:id/refund` |

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
- **WhatsApp templates:** `price_challenge_escalation` and `technician_notification` have to
  be approved in Meta Business Manager. They're used for business-initiated messages
  outside WhatsApp's 24-hour window.
- **Section 16 specifics:** boosts and alerts can be bought from the wallet, with
  eligibility checks that are placeholders until Section 16 arrives. Paying for them
  through a gateway isn't wired up yet.
- **Payout confirmation webhooks:** a payout is marked `sent` when the provider accepts the
  transfer. Webhooks for final settlement (such as Paystack `transfer.success`) aren't
  handled yet.
- **Ad billing:** impressions and clicks are counted, but `spent_minor` isn't charged yet.
- **Search at scale:** matching uses haversine in SQL. Move to PostGIS with a GiST index when
  volume calls for it.
