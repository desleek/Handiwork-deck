const formatters = new Map<string, Intl.NumberFormat>();

/** Minor units (kobo) → "₦12,500". Whole naira shown unless there are kobo. */
export function formatMoney(minor: number | null | undefined, currency = 'NGN'): string {
  if (minor === null || minor === undefined) return '—';
  const hasFraction = minor % 100 !== 0;
  const key = `${currency}:${hasFraction}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f.format(minor / 100);
}

export const toMinor = (major: string | number) => Math.round(Number(String(major).replace(/[^0-9.]/g, '')) * 100);
export const bpsToPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
