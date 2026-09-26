import { DEFAULT_COMMISSION, DEFAULT_LABOR_ONLY_COOLDOWN_DAYS, DEFAULT_MARKUP_CAP_BPS, DEFAULT_RECEIPT_THRESHOLD_MINOR } from '@handiwork/shared';
import { z } from 'zod';
import { type Queryable, pool, query } from '../db/pool';

const money = z.record(z.string().length(3), z.number().int().min(0));

/** Every admin-configurable platform setting, with its validation schema and default. */
export const SETTINGS = {
  /** Section 5: max markup a technician may add to a part's base cost. */
  markup_cap_bps: { schema: z.number().int().min(0).max(100_000), default: DEFAULT_MARKUP_CAP_BPS },
  /** Section 5: platform commission — on labor only, and on disclosed markup only. */
  commission: {
    schema: z.object({ laborBps: z.number().int().min(0).max(10_000), markupBps: z.number().int().min(0).max(10_000) }),
    default: DEFAULT_COMMISSION,
  },
  /** Section 5: parts at/above this base cost (per currency) need a receipt. Missing currency = always required. */
  receipt_threshold_minor: { schema: money, default: DEFAULT_RECEIPT_THRESHOLD_MINOR },
  /** Section 4: minimum days between changes to a per-category labor-only declaration. */
  labor_only_cooldown_days: { schema: z.number().int().min(0).max(3650), default: DEFAULT_LABOR_ONLY_COOLDOWN_DAYS },
  /** Section 4: payout fees and schedule. */
  payouts: {
    schema: z.object({
      instantFeeBps: z.number().int().min(0).max(10_000),
      instantFeeMinMinor: money,
      minPayoutMinor: money,
      standardBatchHourUtc: z.number().int().min(0).max(23),
    }),
    default: { instantFeeBps: 150, instantFeeMinMinor: { NGN: 10_000, USD: 100 }, minPayoutMinor: { NGN: 100_000, USD: 500 }, standardBatchHourUtc: 9 },
  },
  /** Section 4/16: visibility boosts and priority job alerts technicians can buy, and who may buy them. */
  promotions: {
    schema: z.object({
      products: z.record(
        z.string().regex(/^[a-z0-9_]+$/),
        z.object({
          kind: z.enum(['boost', 'alerts']),
          label: z.string(),
          days: z.number().int().min(1).max(365),
          price: money,
          priority: z.number().int().min(0).max(100).optional(),
          radiusFactor: z.number().min(1).max(10).optional(),
        }),
      ),
      eligibility: z.object({
        requireVerified: z.boolean(),
        minRatingAvg: z.number().min(0).max(5),
        maxOpenDisputes: z.number().int().min(0),
        blockedTiers: z.array(z.enum(['new', 'elite', 'trusted', 'standard', 'under_review'])),
      }),
    }),
    default: {
      products: {
        boost_7d: { kind: 'boost', label: 'Visibility boost — 7 days', days: 7, price: { NGN: 500_000, USD: 500 }, priority: 10 },
        boost_30d: { kind: 'boost', label: 'Visibility boost — 30 days', days: 30, price: { NGN: 1_500_000, USD: 1_500 }, priority: 10 },
        alerts_30d: { kind: 'alerts', label: 'Priority job alerts — 30 days (2× reach)', days: 30, price: { NGN: 300_000, USD: 300 }, radiusFactor: 2 },
      },
      eligibility: { requireVerified: true, minRatingAvg: 3.5, maxOpenDisputes: 0, blockedTiers: ['under_review'] },
    },
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

export function isSettingKey(k: string): k is SettingKey {
  return k in SETTINGS;
}

export async function getSetting<K extends SettingKey>(key: K, db: Queryable = pool): Promise<SettingValue<K>> {
  const rows = await query<{ value: unknown }>('SELECT value FROM platform_settings WHERE key = $1', [key], db);
  if (!rows.length) return SETTINGS[key].default as SettingValue<K>;
  const parsed = SETTINGS[key].schema.safeParse(rows[0]!.value);
  return (parsed.success ? parsed.data : SETTINGS[key].default) as SettingValue<K>;
}

export async function allSettings(): Promise<Record<SettingKey, unknown>> {
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM platform_settings');
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, stored.get(k) ?? SETTINGS[k as SettingKey].default])) as Record<SettingKey, unknown>;
}

export async function setSetting(key: SettingKey, value: unknown, adminId: string) {
  const parsed = SETTINGS[key].schema.parse(value);
  await query(
    `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(parsed), adminId],
  );
  return parsed;
}

/** Effective markup cap for a technician: their permanent override if an admin granted one. */
export async function markupCapFor(technicianId: string, db: Queryable = pool): Promise<number> {
  const rows = await query<{ o: number | null }>('SELECT markup_cap_bps_override AS o FROM technician_profiles WHERE user_id = $1', [technicianId], db);
  return rows[0]?.o ?? (await getSetting('markup_cap_bps', db));
}

export async function receiptThreshold(currency: string, db: Queryable = pool): Promise<number> {
  const map = await getSetting('receipt_threshold_minor', db);
  return map[currency.toUpperCase()] ?? 0;
}
