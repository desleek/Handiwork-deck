import { lineTotal, toMajor, toMinor } from '@handiwork/shared';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { ITEM_KIND_LABEL, type Quote } from '@/lib/quotes';
import { Button, Card, Chip, colors, ErrorText, Field, Muted, styles } from './ui';

type Kind = 'labor' | 'material' | 'transport' | 'other';
interface Line {
  kind: Kind;
  description: string;
  quantity: string;
  unitPrice: string; // major units as typed
}

const KINDS: Kind[] = ['labor', 'material', 'transport', 'other'];

/** Technician's itemized quote form; also used to revise an existing quote. */
export function QuoteBuilder({ jobId, currency, existing, onDone }: { jobId: string; currency: string; existing?: Quote; onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>(
    existing
      ? existing.items
          .filter((i) => i.kind !== 'adjustment')
          .map((i) => ({ kind: i.kind as Kind, description: i.description, quantity: String(i.quantity), unitPrice: String(toMajor(i.unit_price_minor, currency)) }))
      : [{ kind: 'labor', description: 'Labor', quantity: '1', unitPrice: '' }],
  );
  const [eta, setEta] = useState(existing?.eta_minutes ? String(existing.eta_minutes) : '');
  const [message, setMessage] = useState(existing?.message ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const parsed = lines.map((l) => ({
    kind: l.kind,
    description: l.description.trim(),
    quantity: Number(l.quantity) || 0,
    unitPriceMinor: toMinor(Number(l.unitPrice) || 0, currency),
  }));
  const total = parsed.reduce((sum, l) => sum + lineTotal(l), 0);
  const valid = parsed.every((l) => l.description.length >= 2 && l.quantity > 0) && total > 0;
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { items: parsed, etaMinutes: eta ? Number(eta) : undefined, message: message.trim() || undefined };
      if (existing) await api(`/jobs/${jobId}/quotes/${existing.id}`, { method: 'PUT', body });
      else await api(`/jobs/${jobId}/quotes`, { body });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text style={styles.label}>{existing ? `Revise quote (rev ${existing.revision + 1})` : 'Itemized quote'}</Text>
      <Muted>Separate labor from materials so the customer can choose labor-only or negotiate.</Muted>
      {lines.map((l, i) => (
        <View key={i} style={{ gap: 6, borderTopWidth: i ? 1 : 0, borderColor: colors.line, paddingTop: i ? 10 : 0 }}>
          <View style={styles.row}>
            {KINDS.map((k) => (
              <Chip key={k} label={ITEM_KIND_LABEL[k]} selected={l.kind === k} onPress={() => update(i, { kind: k })} />
            ))}
          </View>
          <Field label="Description" value={l.description} onChangeText={(v) => update(i, { description: v })} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Qty" value={l.quantity} onChangeText={(v) => update(i, { quantity: v })} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 2 }}>
              <Field label={`Unit price (${currency})`} value={l.unitPrice} onChangeText={(v) => update(i, { unitPrice: v })} keyboardType="decimal-pad" />
            </View>
          </View>
          {lines.length > 1 && (
            <Pressable onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
              <Text style={{ color: colors.danger }}>Remove line</Text>
            </Pressable>
          )}
        </View>
      ))}
      <Button title="Add line" variant="secondary" onPress={() => setLines((ls) => [...ls, { kind: 'material', description: '', quantity: '1', unitPrice: '' }])} />
      <Field label="Can start in (minutes)" value={eta} onChangeText={setEta} keyboardType="number-pad" />
      <Field label="Message to customer" value={message} onChangeText={setMessage} multiline />
      <Text style={{ fontWeight: '700', fontSize: 16 }}>Total {formatMoney(total, currency)}</Text>
      <Button title={existing ? 'Send revised quote' : 'Send quote'} loading={busy} disabled={!valid} onPress={submit} />
      <ErrorText error={error} />
    </Card>
  );
}
