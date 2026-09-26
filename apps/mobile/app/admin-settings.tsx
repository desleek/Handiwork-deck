import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Settings {
  markup_cap_bps: number;
  commission: { laborBps: number; markupBps: number };
  receipt_threshold_minor: Record<string, number>;
  labor_only_cooldown_days: number;
  payouts: { instantFeeBps: number; instantFeeMinMinor: Record<string, number>; minPayoutMinor: Record<string, number>; standardBatchHourUtc: number };
}

const toPct = (bps: number) => String(bps / 100);
const toBps = (p: string) => Math.round(Number(p) * 100);

/** Section 5: admin-configurable pricing rules. */
export default function AdminSettings() {
  const { data, error, loading, reload } = useApi<{ settings: Settings }>('/admin/settings');
  const [laborPct, setLaborPct] = useState('');
  const [markupPct, setMarkupPct] = useState('');
  const [capPct, setCapPct] = useState('');
  const [cooldown, setCooldown] = useState('');
  const [receiptNgn, setReceiptNgn] = useState('');
  const [receiptUsd, setReceiptUsd] = useState('');
  const [instantPct, setInstantPct] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setLaborPct(toPct(s.commission.laborBps));
    setMarkupPct(toPct(s.commission.markupBps));
    setCapPct(toPct(s.markup_cap_bps));
    setCooldown(String(s.labor_only_cooldown_days));
    setReceiptNgn(String((s.receipt_threshold_minor.NGN ?? 0) / 100));
    setReceiptUsd(String((s.receipt_threshold_minor.USD ?? 0) / 100));
    setInstantPct(toPct(s.payouts.instantFeeBps));
  }, [data]);

  if (loading && !data) return <Loading />;
  const save = async (key: string, value: unknown) => {
    setErr(null);
    setMsg(null);
    try {
      await api(`/admin/settings/${key}`, { method: 'PUT', body: { value } });
      setMsg('Saved');
      await reload();
    } catch (e) {
      setErr(e);
    }
  };
  const s = data!.settings;

  return (
    <Screen>
      <Card>
        <Text style={styles.label}>Commission</Text>
        <Muted>Charged on labor and on disclosed markup only — never on the base cost of parts. Applies to quotes accepted after saving.</Muted>
        <Field label="On labor (%)" value={laborPct} onChangeText={setLaborPct} keyboardType="decimal-pad" />
        <Field label="On markup (%)" value={markupPct} onChangeText={setMarkupPct} keyboardType="decimal-pad" />
        <Button title="Save commission" onPress={() => save('commission', { laborBps: toBps(laborPct), markupBps: toBps(markupPct) })} />
      </Card>
      <Card>
        <Text style={styles.label}>Parts markup cap</Text>
        <Field label="Cap (%)" value={capPct} onChangeText={setCapPct} keyboardType="decimal-pad" />
        <Button title="Save cap" onPress={() => save('markup_cap_bps', toBps(capPct))} />
      </Card>
      <Card>
        <Text style={styles.label}>Receipt required for parts from</Text>
        <Field label="NGN (₦)" value={receiptNgn} onChangeText={setReceiptNgn} keyboardType="decimal-pad" />
        <Field label="USD ($)" value={receiptUsd} onChangeText={setReceiptUsd} keyboardType="decimal-pad" />
        <Button
          title="Save thresholds"
          onPress={() => save('receipt_threshold_minor', { ...s.receipt_threshold_minor, NGN: Math.round(Number(receiptNgn) * 100), USD: Math.round(Number(receiptUsd) * 100) })}
        />
      </Card>
      <Card>
        <Text style={styles.label}>Labor-only declaration cooldown</Text>
        <Field label="Days between switches" value={cooldown} onChangeText={setCooldown} keyboardType="number-pad" />
        <Button title="Save cooldown" onPress={() => save('labor_only_cooldown_days', Number(cooldown))} />
      </Card>
      <Card>
        <Text style={styles.label}>Instant payout fee</Text>
        <Field label="Fee (%)" value={instantPct} onChangeText={setInstantPct} keyboardType="decimal-pad" />
        <Button title="Save payout fee" onPress={() => save('payouts', { ...s.payouts, instantFeeBps: toBps(instantPct) })} />
      </Card>
      {msg ? <Muted>{msg}</Muted> : null}
      <ErrorText error={error ?? err} />
    </Screen>
  );
}
