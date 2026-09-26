import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api, uploadFile } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { pct } from '@/lib/quotes';
import { useApi } from '@/lib/useApi';
import { Badge, Card, Chip, colors, ErrorText, Muted, styles } from './ui';

interface Line {
  id: string;
  description: string;
  quantity: number;
  baseMinor: number;
  markupBps: number;
  markupMinor: number;
  totalMinor: number;
  appliesTo: string | null;
  receiptFileId: string | null;
  receiptRequired: boolean;
}
interface Invoice {
  quoteId: string;
  currency: string;
  labor: Line[];
  parts: Line[];
  adjustments: Line[];
  totals: { labor: number; partsBase: number; markup: number; total: number };
  commission?: { laborFee: number; markupFee: number; platformFee: number; technicianPayout: number; laborBps: number; markupBps: number };
  missingReceipts: { id: string }[];
}

/** Section 5 invoice: Labor and Parts/Materials separately, disclosed markup, receipts; commission for the technician. */
export function InvoiceCard({ jobId, isTech }: { jobId: string; isTech: boolean }) {
  const { data, reload } = useApi<{ invoice: Invoice }>(`/jobs/${jobId}/invoice`);
  const [error, setError] = useState<unknown>(null);
  if (!data) return null;
  const inv = data.invoice;
  const c = inv.currency;

  const attach = async (itemId: string) => {
    setError(null);
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const a = r.assets?.[0];
      if (r.canceled || !a) return;
      const fileId = await uploadFile(a.uri, 'receipt', a.mimeType ?? 'image/jpeg');
      await api(`/jobs/${jobId}/quotes/${inv.quoteId}/items/${itemId}/receipt`, { body: { fileId } });
      await reload();
    } catch (e) {
      setError(e);
    }
  };

  const line = (l: Line, right: string, color: string = colors.ink) => (
    <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ flex: 1, color }}>
        {l.description}
        {l.quantity !== 1 ? <Text style={{ color: colors.muted }}> × {l.quantity}</Text> : null}
      </Text>
      <Text style={{ color }}>{right}</Text>
    </View>
  );

  return (
    <Card>
      <Text style={styles.label}>Invoice</Text>
      <Text style={{ fontSize: 12, fontWeight: '700', color: colors.muted }}>LABOR</Text>
      {inv.labor.map((l) => line(l, formatMoney(l.totalMinor, c)))}
      {inv.parts.length > 0 && <Text style={{ fontSize: 12, fontWeight: '700', color: colors.muted, marginTop: 4 }}>PARTS / MATERIALS</Text>}
      {inv.parts.map((l) => (
        <View key={l.id} style={{ gap: 2 }}>
          {line(l, formatMoney(l.baseMinor, c))}
          {l.markupMinor > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Muted>  Markup {pct(l.markupBps)}</Muted>
              <Muted>{formatMoney(l.markupMinor, c)}</Muted>
            </View>
          )}
          {l.receiptRequired && (
            <View style={styles.row}>
              <Badge label={l.receiptFileId ? 'Receipt on file' : 'Receipt required'} tone={l.receiptFileId ? 'good' : 'warn'} />
              {isTech && <Chip label={l.receiptFileId ? 'Replace receipt' : 'Attach receipt'} onPress={() => attach(l.id)} />}
            </View>
          )}
        </View>
      ))}
      {inv.adjustments.map((l) => line(l, formatMoney(l.totalMinor, c), colors.success))}
      <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 4, gap: 2 }}>
        <Muted>
          Labor {formatMoney(inv.totals.labor, c)} · Parts {formatMoney(inv.totals.partsBase, c)} · Markup {formatMoney(inv.totals.markup, c)}
        </Muted>
        <Text style={{ fontWeight: '800', textAlign: 'right' }}>Total {formatMoney(inv.totals.total, c)}</Text>
        {inv.commission && (
          <Muted>
            Commission {formatMoney(inv.commission.platformFee, c)} ({pct(inv.commission.laborBps)} labor + {pct(inv.commission.markupBps)} markup) — your payout{' '}
            {formatMoney(inv.commission.technicianPayout, c)}
          </Muted>
        )}
      </View>
      {isTech && inv.missingReceipts.length > 0 && <Muted>Attach the required receipts before marking the job completed.</Muted>}
      <ErrorText error={error} />
    </Card>
  );
}
