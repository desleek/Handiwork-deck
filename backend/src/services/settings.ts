import { query, type Db } from '../db/pool.ts';
import { DEFAULT_SETTINGS, resolveSettings, type PlatformSettings, type SettingKey } from '../domain/settings.ts';

let cache: { at: number; value: PlatformSettings } | null = null;
const TTL_MS = 30_000;

export async function getSettings(): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM platform_settings');
  cache = { at: Date.now(), value: resolveSettings(rows) };
  return cache.value;
}

export function invalidateSettings() {
  cache = null;
}

export async function updateSetting(key: SettingKey, value: unknown, adminId: string, reason: string | undefined, db: Db) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${key}`);
  const before = (await getSettings())[key];
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), adminId],
    db,
  );
  await query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, before, after, reason)
     VALUES ($1, 'setting.update', 'setting', $2, $3, $4, $5)`,
    [adminId, key, JSON.stringify(before), JSON.stringify(value), reason ?? null],
    db,
  );
  invalidateSettings();
}
