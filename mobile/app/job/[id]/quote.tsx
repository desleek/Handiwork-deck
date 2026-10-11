import { useMutation } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { api, ApiError, uploadFile } from '../../../src/api/client';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag } from '../../../src/components/ui';
import { bpsToPct, formatMoney, toMinor } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

interface Draft {
  kind: 'labor' | 'part';
  description: string;
  quantity: string;
  unitCost: string; // naira as typed
  markupPct: string;
  receiptUrl?: string;
  exception?: { reason: string; evidenceUrls: string[] };
}

const blankLabor = (): Draft => ({ kind: 'labor', description: '', quantity: '1', unitCost: '', markupPct: '0' });
const blankPart = (): Draft => ({ kind: 'part', description: '', quantity: '1', unitCost: '', markupPct: '10' });

/**
 * Itemized quote builder (Section 4): labor + parts + disclosed markup, live server-side preview,
 * markup cap enforced, receipts for expensive parts, and "Request Cap Exception" (Section 5a).
 */
export default function QuoteBuilder() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [lines, setLines] = useState<Draft[]>([blankLabor()]);
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<any>(null);

  const toItems = () =>
    lines
      .filter((l) => l.description.trim() && l.unitCost)
      .map((l) => ({
        kind: l.kind,
        description: l.description.trim(),
        quantity: Number(l.quantity) || 1,
        unitCostMinor: toMinor(l.unitCost),
        markupBps: l.kind === 'part' ? Math.round(Number(l.markupPct || 0) * 100) : 0,
        receiptUrl: l.receiptUrl,
      }));

  // Debounced live preview from the API — the same pricing engine that enforces the rules.
  useEffect(() => {
    const items = toItems();
    if (!items.length) return setPreview(null);
    const h = setTimeout(() => api(`/jobs/${id}/quotes/preview`, { body: { items } }).then(setPreview).catch(() => {}), 400);
    return () => clearTimeout(h);
  }, [lines]);

  const overCap = new Map<number, number>((preview?.issues ?? []).filter((i: any) => i.code === 'MARKUP_OVER_CAP').map((i: any) => [i.position, i.capBps]));
  const receiptNeeded = new Set<number>((preview?.issues ?? []).filter((i: any) => i.code === 'RECEIPT_REQUIRED').map((i: any) => i.position));

  const submit = useMutation({
    mutationFn: () => {
      const items = toItems();
      const capExceptions = lines
        .filter((l) => l.description.trim() && l.unitCost)
        .map((l, i) => ({ l, position: i + 1 }))
        .filter(({ position }) => overCap.has(position))
        .map(({ l, position }) => ({
          position,
          requestedMarkupBps: Math.round(Number(l.markupPct) * 100),
          reason: l.exception?.reason ?? '',
          evidenceUrls: l.exception?.evidenceUrls ?? [],
        }));
      return api(`/jobs/${id}/quotes`, { body: { items, notes: notes || undefined, capExceptions } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      router.back();
    },
    onError: (e: ApiError) => Alert.alert('Quote not sent', e.message),
  });

  const pick = async (kind: 'receipt' | 'evidence') => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (r.canceled) return null;
    const a = r.assets[0];
    return uploadFile(kind, { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 1_000_000, name: a.fileName ?? 'photo.jpg' });
  };

  const update = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(2.5), color: t.color.text, borderWidth: 1, borderColor: t.color.border };
  const missingExceptionInfo = [...overCap.keys()].some((pos) => {
    const l = lines.filter((x) => x.description.trim() && x.unitCost)[pos - 1];
    return !l?.exception?.reason || l.exception.reason.length < 10 || !l.exception.evidenceUrls.length;
  });

  return (
    <Screen>
      {lines.map((l, i) => {
        const pos = i + 1;
        return (
          <Card key={i}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Tag label={l.kind === 'labor' ? 'Labor' : 'Part / material'} tone={l.kind === 'labor' ? 'success' : 'neutral'} />
              {lines.length > 1 ? <Pressable onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))}><T v="small" style={{ color: t.color.danger }}>Remove</T></Pressable> : null}
            </Row>
            <TextInput value={l.description} onChangeText={(v) => update(i, { description: v })} placeholder={l.kind === 'labor' ? 'e.g. Replace kitchen tap' : 'e.g. Mixer tap (chrome)'} placeholderTextColor={t.color.textMuted} style={input} />
            <Row>
              <View style={{ flex: 1 }}>
                <T v="tiny" muted>{l.kind === 'labor' ? 'Your standard rate (₦)' : 'Base cost each (₦)'}</T>
                <TextInput value={l.unitCost} onChangeText={(v) => update(i, { unitCost: v })} keyboardType="numeric" style={input} />
              </View>
              <View style={{ width: 70 }}>
                <T v="tiny" muted>Qty</T>
                <TextInput value={l.quantity} onChangeText={(v) => update(i, { quantity: v })} keyboardType="numeric" style={input} />
              </View>
              {l.kind === 'part' ? (
                <View style={{ width: 80 }}>
                  <T v="tiny" muted>Markup %</T>
                  <TextInput value={l.markupPct} onChangeText={(v) => update(i, { markupPct: v })} keyboardType="numeric" style={input} />
                </View>
              ) : null}
            </Row>
            {receiptNeeded.has(pos) ? (
              <Button title={l.receiptUrl ? 'Receipt attached ✓' : 'Attach receipt (required)'} kind="secondary" onPress={async () => { const u = await pick('receipt'); if (u) update(i, { receiptUrl: u }); }} />
            ) : null}
            {overCap.has(pos) ? (
              <View style={{ gap: t.space(2) }}>
                <Banner text={`Markup is above the ${bpsToPct(overCap.get(pos)!)} cap. Lower it, or request a cap exception with supplier evidence.`} />
                <TextInput value={l.exception?.reason ?? ''} onChangeText={(v) => update(i, { exception: { reason: v, evidenceUrls: l.exception?.evidenceUrls ?? [] } })} multiline placeholder="Reason (e.g. scarce part, special sourcing trip)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 60 }]} />
                <Button
                  title={l.exception?.evidenceUrls.length ? `${l.exception.evidenceUrls.length} evidence file(s) ✓` : 'Add supplier invoice / price proof'}
                  kind="secondary"
                  onPress={async () => {
                    const u = await pick('evidence');
                    if (u) update(i, { exception: { reason: l.exception?.reason ?? '', evidenceUrls: [...(l.exception?.evidenceUrls ?? []), u] } });
                  }}
                />
              </View>
            ) : null}
          </Card>
        );
      })}

      <Row>
        <View style={{ flex: 1 }}><Button title="+ Labor" kind="secondary" onPress={() => setLines((ls) => [...ls, blankLabor()])} /></View>
        <View style={{ flex: 1 }}><Button title="+ Part" kind="secondary" onPress={() => setLines((ls) => [...ls, blankPart()])} /></View>
      </Row>
      <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Notes for the customer (optional)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 60, backgroundColor: t.color.surface }]} />

      {preview ? (
        <Card>
          <T v="heading">Preview</T>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Labor{preview.lines.some((x: any) => x.kind === 'labor' && x.baseLaborMinor !== x.unitCostMinor) ? ' (incl. performance rate)' : ''}</T><T>{formatMoney(preview.totals.laborTotalMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Parts base</T><T>{formatMoney(preview.totals.partsBaseTotalMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Markup</T><T>{formatMoney(preview.totals.markupTotalMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">Customer pays</T><T v="heading">{formatMoney(preview.totals.customerTotalMinor)}</T></Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fees</T><T v="small" muted>−{formatMoney(preview.totals.platformCommissionMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">You receive</T><T v="heading">{formatMoney(preview.totals.technicianNetMinor)}</T></Row>
        </Card>
      ) : null}

      <Button
        title={overCap.size ? 'Send for cap review' : 'Send quote'}
        loading={submit.isPending}
        disabled={!preview || receiptNeeded.size > 0 && lines.some((l, i) => receiptNeeded.has(i + 1) && !l.receiptUrl) || (overCap.size > 0 && missingExceptionInfo)}
        onPress={() => submit.mutate()}
      />
    </Screen>
  );
}
