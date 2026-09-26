import { commissionFor, priceLine, type QuoteItemInput, quoteTotals, toMajor, toMinor } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api, ApiError, uploadFile } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { type Pricing, pct, type Quote } from '@/lib/quotes';
import { useApi } from '@/lib/useApi';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Muted, styles } from './ui';

interface Line {
  kind: 'labor' | 'material';
  description: string;
  quantity: string;
  unitPrice: string; // major units: labor rate, or part base cost per unit
  markupPct: string;
  receiptFileId?: string;
  exception?: { reason: string; evidenceFileIds: string[] };
}

/**
 * Technician's itemized quote: Labor lines and Parts lines, each part showing
 * base cost, markup % and markup amount. Markup above the cap is blocked unless
 * a cap exception (Demand Notice) with reason and evidence is attached.
 */
export function QuoteBuilder({ jobId, currency, existing, onDone }: { jobId: string; currency: string; existing?: Quote; onDone: () => void }) {
  const { data: pricing } = useApi<Pricing>('/technicians/me/pricing');
  const [lines, setLines] = useState<Line[]>(
    existing
      ? existing.items
          .filter((i) => i.kind !== 'adjustment')
          .map((i) => ({
            kind: i.kind as 'labor' | 'material',
            description: i.description,
            quantity: String(i.quantity),
            unitPrice: String(toMajor(i.unit_price_minor, currency)),
            markupPct: String(i.markup_bps / 100),
            receiptFileId: i.receipt_file_id ?? undefined,
          }))
      : [{ kind: 'labor', description: 'Labor', quantity: '1', unitPrice: '', markupPct: '0' }],
  );
  const [eta, setEta] = useState(existing?.eta_minutes ? String(existing.eta_minutes) : '');
  const [message, setMessage] = useState(existing?.message ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const cap = pricing?.markupCapBps ?? 2000;
  const threshold = pricing?.receiptThresholdMinor[currency] ?? 0;
  const items: QuoteItemInput[] = lines.map((l) =>
    l.kind === 'labor'
      ? { kind: 'labor', description: l.description.trim(), quantity: Number(l.quantity) || 0, unitPriceMinor: toMinor(Number(l.unitPrice) || 0, currency) }
      : {
          kind: 'material',
          description: l.description.trim(),
          quantity: Number(l.quantity) || 0,
          unitPriceMinor: toMinor(Number(l.unitPrice) || 0, currency),
          markupBps: Math.round((Number(l.markupPct) || 0) * 100),
        },
  );
  const priced = items.map(priceLine);
  const totals = quoteTotals(priced);
  const commission = pricing ? commissionFor(totals, pricing.commission) : null;
  const overCap = items.map((i) => i.kind === 'material' && i.markupBps > cap);
  const valid =
    items.every((i) => i.description.length >= 2 && i.quantity > 0) &&
    items.some((i) => i.kind === 'labor') &&
    totals.total > 0 &&
    lines.every((l, idx) => !overCap[idx] || (l.exception && l.exception.reason.trim().length >= 10 && l.exception.evidenceFileIds.length > 0));
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickFile = async (kind: 'receipt') => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const a = r.assets?.[0];
    if (r.canceled || !a) return null;
    return uploadFile(a.uri, kind, a.mimeType ?? 'image/jpeg');
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        items: items.map((it, idx) => ({
          ...it,
          ...(it.kind === 'material' && lines[idx]!.receiptFileId ? { receiptFileId: lines[idx]!.receiptFileId } : {}),
          ...(overCap[idx] ? { capException: { reason: lines[idx]!.exception!.reason.trim(), evidenceFileIds: lines[idx]!.exception!.evidenceFileIds } } : {}),
        })),
        etaMinutes: eta ? Number(eta) : undefined,
        message: message.trim() || undefined,
      };
      if (existing) await api(`/jobs/${jobId}/quotes/${existing.id}`, { method: 'PUT', body });
      else await api(`/jobs/${jobId}/quotes`, { body });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'markup_cap_exceeded' ? new Error(`${e.message}.`) : e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text style={styles.label}>{existing ? `Revise quote (rev ${existing.revision + 1})` : 'Itemized quote'}</Text>
      <Muted>
        Labor and parts are always listed separately. Part markup is shown to the customer and capped at {pct(cap)}.
      </Muted>
      {lines.map((l, i) => {
        const p = priced[i]!;
        return (
          <View key={i} style={{ gap: 6, borderTopWidth: i ? 1 : 0, borderColor: colors.line, paddingTop: i ? 10 : 0 }}>
            <View style={styles.row}>
              <Chip label="Labor" selected={l.kind === 'labor'} onPress={() => update(i, { kind: 'labor', markupPct: '0' })} />
              <Chip label="Part / material" selected={l.kind === 'material'} onPress={() => update(i, { kind: 'material' })} />
            </View>
            <Field label="Description" value={l.description} onChangeText={(v) => update(i, { description: v })} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Qty" value={l.quantity} onChangeText={(v) => update(i, { quantity: v })} keyboardType="decimal-pad" />
              </View>
              <View style={{ flex: 2 }}>
                <Field
                  label={l.kind === 'labor' ? `Rate (${currency})` : `Base cost / unit (${currency})`}
                  value={l.unitPrice}
                  onChangeText={(v) => update(i, { unitPrice: v })}
                  keyboardType="decimal-pad"
                />
              </View>
              {l.kind === 'material' && (
                <View style={{ flex: 1 }}>
                  <Field label="Markup %" value={l.markupPct} onChangeText={(v) => update(i, { markupPct: v })} keyboardType="decimal-pad" />
                </View>
              )}
            </View>
            {l.kind === 'material' && (
              <Muted>
                Base {formatMoney(p.baseMinor, currency)} + markup {pct(p.markupBps)} = {formatMoney(p.markupMinor, currency)} → {formatMoney(p.totalMinor, currency)}
              </Muted>
            )}
            {l.kind === 'material' && p.baseMinor >= threshold && (
              <View style={styles.row}>
                {l.receiptFileId ? <Badge label="Receipt attached" tone="good" /> : <Badge label="Receipt required before completion" tone="warn" />}
                <Chip
                  label={l.receiptFileId ? 'Replace receipt' : 'Attach receipt'}
                  onPress={async () => {
                    const id = await pickFile('receipt');
                    if (id) update(i, { receiptFileId: id });
                  }}
                />
              </View>
            )}
            {overCap[i] && (
              <View style={{ backgroundColor: '#FEF3C7', borderRadius: 8, padding: 10, gap: 6 }}>
                <Text style={{ fontWeight: '700', color: '#92400E' }}>Above the {pct(cap)} cap — request a cap exception</Text>
                <Muted>Our team reviews it with your evidence; the customer sees the quote as "under review" until then.</Muted>
                <Field
                  label="Reason"
                  value={l.exception?.reason ?? ''}
                  onChangeText={(v) => update(i, { exception: { reason: v, evidenceFileIds: l.exception?.evidenceFileIds ?? [] } })}
                  multiline
                  placeholder="e.g. Only available from one supplier; price has risen this month"
                />
                <View style={styles.row}>
                  <Badge label={`${l.exception?.evidenceFileIds.length ?? 0} evidence file(s)`} tone={l.exception?.evidenceFileIds.length ? 'good' : 'warn'} />
                  <Chip
                    label="Add supplier invoice / price proof"
                    onPress={async () => {
                      const id = await pickFile('receipt');
                      if (id) update(i, { exception: { reason: l.exception?.reason ?? '', evidenceFileIds: [...(l.exception?.evidenceFileIds ?? []), id] } });
                    }}
                  />
                </View>
              </View>
            )}
            {lines.length > 1 && (
              <Pressable onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <Text style={{ color: colors.danger }}>Remove line</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      <View style={styles.row}>
        <Chip label="+ Labor line" onPress={() => setLines((ls) => [...ls, { kind: 'labor', description: '', quantity: '1', unitPrice: '', markupPct: '0' }])} />
        <Chip label="+ Part line" onPress={() => setLines((ls) => [...ls, { kind: 'material', description: '', quantity: '1', unitPrice: '', markupPct: String(cap / 100) }])} />
      </View>
      <Field label="Can start in (minutes)" value={eta} onChangeText={setEta} keyboardType="number-pad" />
      <Field label="Message to customer" value={message} onChangeText={setMessage} multiline />

      <View style={{ gap: 2 }}>
        <Muted>Labor {formatMoney(totals.labor, currency)}</Muted>
        <Muted>
          Parts {formatMoney(totals.partsBase, currency)} + markup {formatMoney(totals.markup, currency)}
        </Muted>
        <Text style={{ fontWeight: '800', fontSize: 16 }}>Total {formatMoney(totals.total, currency)}</Text>
        {commission && pricing && (
          <Muted>
            Platform commission {formatMoney(commission.platformFee, currency)} ({pct(pricing.commission.laborBps)} of labor, {pct(pricing.commission.markupBps)} of markup, 0% of part cost) — you receive{' '}
            {formatMoney(commission.technicianPayout, currency)}
          </Muted>
        )}
      </View>
      <Button title={existing ? 'Send revised quote' : 'Send quote'} loading={busy} disabled={!valid} onPress={submit} />
      <ErrorText error={error} />
    </Card>
  );
}

