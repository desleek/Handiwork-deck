# Decisions log

Defaults chosen during the first build. Every item marked ⚙️ is an admin setting (`/admin/settings/:key`), so changing it needs no code change.

## Section 22 open decisions

| Decision | Default implemented | Where |
|---|---|---|
| Commission on consultancy fees | 0% ⚙️ `consultancyCommissionBps` | Decide before Phase 3 |
| Tier 1 restricted functions | Customers: `create_booking`. Technicians: `accept_job`, `purchase_boost`, `purchase_push_alert`. In-progress jobs, chat, payments and withdrawals stay open. ⚙️ `restrictedFunctions` | `penalties.ts` |
| WhatsApp Business API provider | Meta Cloud API adapter. The `WhatsAppProvider` interface allows a Twilio or 360dialog adapter instead. Needs approved templates: `job_message_relay`, `new_job_request`, `price_challenge_escalated`, `generic_alert`. | `services/messaging/whatsapp.ts` |
| Virtual accounts | Per-transaction "pay with transfer" accounts work now; dedicated per-customer accounts need CAC-verified business onboarding with Paystack/Flutterwave. **Start that paperwork early.** | `payments/paystack.ts`, `flutterwave.ts` |
| Hour-72 / Fast Track Hour-24 final action | Auto-approve the customer's evidence, applied globally. ⚙️ `priceChallengeFinalAction` can switch to auto-cancel + redirect to labor-only. | `queue/escalations.ts` |
| Tie-break among boosted technicians | Highest bid first, then rating. ⚙️ `boostTieBreak` = `even_rotation` rotates hourly. | `domain/discovery.ts` |
| Boost pricing | Flat ₦5,000/hour. ⚙️ `boostPricingMode` = `variable` lets technicians pay up to the cap. | `domain/boosts.ts` |

## Spec inconsistency to confirm

**Fast Track timing.** The spec says Fast Track compresses the timeline *proportionally* into 24 hours, but then lists admin escalation at Hour 8. Proportional compression (÷3) would put escalation at Hour 16 and reminders through Hour 10. The explicit numbers are implemented (respond by H2, hourly reminders to H8, escalate H8, final H24). Both timelines are settings, so either reading is a config change.

## Other defaults chosen

- **Who pays commission:** the customer pays labor + parts + markup. Commission is deducted from the technician's side and shown to the customer as "included", never added on top. A customer service fee setting exists, default 0%.
- **Receipt threshold** applies to a part line's base total (unit cost × quantity) above ₦50,000.
- **Rating tiers:** rolling average ≥4.5 → 5★ tier (+10%), ≥3.5 → 4★ (+5%), ≥2.5 → 3★ (0%), ≥1.5 → 2★ (−5%), below → 1★ (−10%). Technicians with no reviews sit at 0%.
- **Rolling average:** exponential time-weighting with a 90-day half-life ⚙️. The same figure drives display, the multiplier and the 3★ boost gate.
- **Labor-only rejection penalty:** −0.1★ on the rolling average per rejection beyond the cap, within the 90-day window ⚙️. Exceeding the cap also writes an admin flag.
- **Multiplier anomalies:** a swing of 2+ tiers, or any tier change driven by fewer than 2 new reviews, is held at the previous value until an admin confirms or overrides it.
- **Withdrawals:** standard is free and batched each business day at 09:00. Instant is 1% (min ₦100, max ₦2,000) ⚙️. Customer wallet-to-bank is off until the fast-follow ⚙️ `customerWithdrawalsEnabled`.
- **Wallet bonus tiers:** "₦100,000 – ₦500,000" is inclusive of ₦500,000 (0.2%); "Above ₦500,000" starts at ₦500,000.01 (0.3%).
- **Contact release:** phone numbers unlock when the job is **funded** (payment held), the first point it's both approved and committed.
- **Live location** goes through the API into Postgres (`technician_profiles.last_lat/lng`) and is polled by the app, rather than Firebase Realtime Database. This keeps the "only while online" rule and geo search on the server. Firebase RTDB can be added later for second-by-second streaming.
- **Phase gating:** Phase 2/3 features ship switched off ⚙️ `features.*`.
- **Category list:** exact duplicates in the spec ("Phone repair", "Photographer request") were seeded once. Near-duplicates ("Electrical" / "Electrical repair", "Cleaning services" / "Cleaner request") were kept so an admin can merge or deactivate them.
- **Account deletion** anonymises personal data and keeps job, payment and review records anonymised for audit. It's blocked while funded jobs are open or the wallet has a balance.
