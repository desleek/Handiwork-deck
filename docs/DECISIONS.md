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

## Phase 2 defaults

- **Gateway fee schedules** ⚙️ `gatewayFeeSchedules`: Paystack 1.5% + ₦100 (₦100 waived under ₦2,500), capped at ₦2,000; dedicated virtual accounts 1% capped at ₦300. Flutterwave 1.4% capped at ₦2,000. Payout fees ₦10 / ₦25 / ₦50 by amount band. Taken from the providers' published Nigerian pricing in October 2026 — replace with your signed rate card.
- **Wallet bonus economics:** at a ₦25,000 average job, every default tier is funded by fee savings. When the average job approaches ₦50,000, the 0.1% tier on a ₦50,000 card top-up stops being funded (one capped top-up fee ≈ one job fee), but stays funded if topped up by virtual account. The admin economics report uses the real 90-day average job value once there are 20+ paid jobs, and saving tiers that lose money returns warnings (it doesn't block).
- **Ad slot prices** ⚙️ `adSlotPricePerDayMinor`: ₦5,000/day featured Deals, ₦3,000/day brand Deals, ₦10,000/day sponsored search; campaigns run 1–90 days. These are placeholders — set them from real demand.
- **Ad lifecycle:** submitted → admin review (rejections need a reason) → paid (gateway, wallet, offline invoice recorded by an admin, or fee waived) → live inside its date window. Impressions and clicks count once per user per campaign per day.
- **Boost overlap:** a technician can't hold two boosts for the same service at the same time; the app offers a later start instead.
- **Abandoned checkouts:** unpaid boosts and alerts are released after 30 minutes so they don't block the slot or count toward the daily alert limit.

## Phase 3 defaults

### Construction (Section 17)
- **Consultancy fee bands** ⚙️ `consultancyFeeBands` keyed by category slug (e.g. `c-roofing`), falling back to ⚙️ `consultancyDefaultBand` (₦5,000–₦150,000).
- **Platform cut on consultancy fees:** 0% ⚙️ `consultancyCommissionBps` — still an open decision from Section 22.
- **When the consultancy fee is earned:** held in escrow at payment, released to the technician when the BOQ is submitted or 48 hours after the visit, whichever comes first. Cancelling before the visit refunds it; after the visit it's released.
- **No-show:** the customer can report one 3 hours ⚙️ `consultancyNoShowGraceHours` after the agreed time. If the technician hasn't marked the visit done, it's refunded automatically (⚙️ `consultancyRefundOnNoShow`); if they have, it becomes an admin dispute.
- **Performance multiplier** applies to BOQ labour rates the same way it applies to quote labour, frozen at submission.
- **Markup cap** applies to BOQ materials. Demand Notice exceptions are not available on BOQs — a technician who needs a higher cap can be given a permanent override by an admin.
- **Receipts** aren't required on a BOQ, since it's a pre-purchase estimate.
- **Milestones:** every BOQ line belongs to exactly one milestone; up to 12 ⚙️ `maxMilestones`. Funded strictly in order. Commission is computed per milestone, and project totals are the sum of milestone totals so payouts always reconcile.
- **BOQ imports:** Excel (.xlsx) and CSV are the primary path; Word (.docx) and PDF are best-effort. Every import becomes a draft that the technician must confirm line by line before the customer sees it. Lines where amount ≠ qty × rate, or where a value was derived, are flagged. Scanned PDFs and PDFs with embedded custom fonts can't be read and fall back to manual entry. Sections in the file (e.g. Substructure / Superstructure) are suggested as milestones.

### Supplies marketplace (Section 13)
- **Greenlight milestones** ⚙️ `suppliesGreenlight`: 2,000 monthly active customers, 1,000 completed jobs in 30 days, 25 verified sellers. Switching `features.supplies` on is refused until they're met, unless the admin passes `overrideGreenlight`. Placeholders — set your own targets.
- **Commission:** 5% on goods ⚙️ `suppliesCommissionBps`; delivery fees go to the seller in full.
- **Who can sell:** sellers in the verified registry with an advertiser login, after an admin opens their storefront. New and edited listings go through moderation; price and stock changes don't.
- **Carts:** one seller per order, so each order has one fulfiller and one payout.
- **Stock** is reserved when payment lands, not when the order is placed; if it runs out in between, the buyer is refunded automatically.
- **Payout:** on the buyer's confirmation, or automatically 3 days ⚙️ `suppliesAutoConfirmDays` after dispatch / ready-for-pickup.
- **Seller logins:** admins create advertiser/seller accounts with a phone number; the person claims the account the first time they sign in with that number.
