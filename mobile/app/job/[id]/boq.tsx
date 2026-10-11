import { useMutation, useQuery } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Switch, TextInput, View } from 'react-native';
import { api, ApiError, apiUpload } from '../../../src/api/client';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag } from '../../../src/components/ui';
import { formatMoney, toMinor } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

interface Line {
  kind: 'labor' | 'part';
  description: string;
  unit: string;
  quantity: string;
  rate: string; // naira as typed
  markupPct: string;
  milestone: number;
  flag?: string | null;
  sourceRow?: number;
  customerComment?: string | null;
}

const blank = (milestone: number, kind: 'labor' | 'part' = 'part'): Line => ({ kind, description: '', unit: '', quantity: '', rate: '', markupPct: kind === 'part' ? '10' : '0', milestone });
const naira = (minor: number) => String(minor / 100);

/**
 * Bill of Quantities builder (Section 17, Step 2): build it line by line, or import an existing
 * Excel/CSV/Word/PDF BOQ. Imported lines must be reviewed before submitting — Word/PDF imports
 * are best-effort, and flagged lines are highlighted with the parser's reason.
 */
export default function BoqBuilder() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const existing = useQuery({ queryKey: ['construction', id], queryFn: () => api(`/jobs/${id}/construction`) });
  const [milestones, setMilestones] = useState<string[]>(['Milestone 1']);
  const [lines, setLines] = useState<Line[]>([blank(1, 'labor')]);
  const [notes, setNotes] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [prefilled, setPrefilled] = useState(false);

  // Revising: start from the current BOQ (with the customer's comments shown on each line).
  useEffect(() => {
    const b = existing.data?.boq;
    if (prefilled || !b || b.status === 'draft' || !b.milestones?.length) return;
    setMilestones(b.milestones.map((m: any) => m.title));
    setLines(
      b.items.map((i: any) => ({
        kind: i.kind,
        description: i.description,
        unit: i.unit,
        quantity: String(Number(i.quantity)),
        rate: naira(i.base_labor_minor ?? i.unit_rate_minor),
        markupPct: String(i.markup_bps / 100),
        milestone: i.milestone_position ?? 1,
        customerComment: i.customer_comment,
      })),
    );
    setNotes(b.notes ?? '');
    setPrefilled(true);
  }, [existing.data, prefilled]);

  const items = () =>
    lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        kind: l.kind,
        description: l.description.trim(),
        unit: l.unit.trim(),
        quantity: Number(l.quantity) || 0,
        unitRateMinor: toMinor(l.rate || 0),
        markupBps: l.kind === 'part' ? Math.round(Number(l.markupPct || 0) * 100) : 0,
        milestone: l.milestone,
      }));
  const body = () => ({ items: items(), milestones: milestones.map((title) => ({ title: title.trim() || 'Milestone' })), notes: notes || undefined });

  useEffect(() => {
    if (!items().length) return setPreview(null);
    const h = setTimeout(() => api(`/jobs/${id}/construction/boq/preview`, { body: body() }).then(setPreview).catch(() => {}), 500);
    return () => clearTimeout(h);
  }, [lines, milestones]);

  const importFile = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
        'text/comma-separated-values',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/pdf',
      ],
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const f = r.assets[0];
    try {
      const parsed = await apiUpload(`/jobs/${id}/construction/boq/parse`, { uri: f.uri, mimeType: f.mimeType ?? '', name: f.name });
      const sections: string[] = parsed.suggestedMilestones?.length ? parsed.suggestedMilestones : ['Milestone 1'];
      setMilestones(sections.map((x: string) => x.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase())));
      setLines(
        parsed.lines.map((l: any) => ({
          kind: l.kind,
          description: l.description,
          unit: l.unit,
          quantity: String(l.quantity),
          rate: naira(l.unitRateMinor),
          markupPct: String(l.markupBps / 100),
          milestone: Math.max(1, sections.indexOf(l.section) + 1),
          flag: l.flag,
          sourceRow: l.sourceRow,
        })),
      );
      setDraftId(parsed.draftId);
      setWarnings(parsed.warnings ?? []);
      setReviewed(false);
    } catch (e: any) {
      Alert.alert('Could not read the file', e.message);
    }
  };

  const submit = useMutation({
    mutationFn: () => api(`/jobs/${id}/construction/boq`, { body: { ...body(), draftId: draftId ?? undefined, reviewedParsedLines: draftId ? reviewed : undefined } }),
    onSuccess: () => {
      ['construction', 'job'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k, id] }));
      router.back();
    },
    onError: (e: ApiError) => Alert.alert('BOQ not sent', Array.isArray(e.details) ? (e.details as any[]).map((d) => d.message).join('\n') : e.message),
  });

  // Editing a flagged line clears its flag: the technician has looked at it.
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch, flag: null } : l)));
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(2.5), color: t.color.text, borderWidth: 1, borderColor: t.color.border };
  const chip = (on: boolean) => ({ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 100, backgroundColor: on ? t.color.primary : t.color.surfaceAlt });
  const issues: any[] = preview?.issues ?? [];
  const flagged = lines.filter((l) => l.flag).length;

  return (
    <Screen>
      <Button title="Import Excel, CSV, Word or PDF" kind="secondary" onPress={importFile} />
      {draftId ? (
        <Banner
          tone={flagged || warnings.length ? 'warning' : 'info'}
          text={`Imported ${lines.length} lines.${flagged ? ` ${flagged} need checking (highlighted).` : ''} ${warnings.filter((w) => !/need checking/.test(w)).join(' ')} Check every line against your file before sending — the customer only sees it after you submit.`}
        />
      ) : null}

      <Card>
        <T v="heading">Milestones</T>
        <T v="small" muted>The customer funds each milestone separately and releases payment when it's done.</T>
        {milestones.map((m, i) => (
          <Row key={i}>
            <T style={{ width: 22 }}>{i + 1}.</T>
            <TextInput value={m} onChangeText={(v) => setMilestones((ms) => ms.map((x, j) => (j === i ? v : x)))} style={[input, { flex: 1 }]} />
            {milestones.length > 1 ? (
              <Pressable
                hitSlop={8}
                onPress={() => {
                  setMilestones((ms) => ms.filter((_, j) => j !== i));
                  setLines((ls) => ls.map((l) => ({ ...l, milestone: l.milestone > i + 1 ? l.milestone - 1 : l.milestone === i + 1 ? 1 : l.milestone })));
                }}
              >
                <T style={{ color: t.color.danger }}>✕</T>
              </Pressable>
            ) : null}
          </Row>
        ))}
        <Button title="+ Milestone" kind="ghost" onPress={() => setMilestones((ms) => [...ms, `Milestone ${ms.length + 1}`])} />
      </Card>

      {lines.map((l, i) => (
        <Card key={i} style={l.flag ? { borderWidth: 2, borderColor: t.color.accent } : undefined}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row gap={1}>
              {(['labor', 'part'] as const).map((k) => (
                <Pressable key={k} onPress={() => update(i, { kind: k, markupPct: k === 'labor' ? '0' : l.markupPct })} style={chip(l.kind === k)}>
                  <T v="small" style={{ color: l.kind === k ? t.color.primaryText : t.color.text }}>{k === 'labor' ? 'Labour' : 'Materials'}</T>
                </Pressable>
              ))}
            </Row>
            <Row gap={2}>
              {l.sourceRow ? <T v="tiny" muted>row {l.sourceRow}</T> : null}
              <Pressable hitSlop={8} onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                <T v="small" style={{ color: t.color.danger }}>Remove</T>
              </Pressable>
            </Row>
          </Row>
          {l.flag ? <T v="tiny" style={{ color: t.color.promoted }}>Check: {l.flag}</T> : null}
          {l.customerComment ? <T v="tiny" style={{ color: t.color.promoted }}>Customer: {l.customerComment}</T> : null}
          <TextInput value={l.description} onChangeText={(v) => update(i, { description: v })} placeholder="e.g. 225mm sandcrete block walling" placeholderTextColor={t.color.textMuted} style={input} />
          <Row>
            <View style={{ width: 64 }}>
              <T v="tiny" muted>Unit</T>
              <TextInput value={l.unit} onChangeText={(v) => update(i, { unit: v })} placeholder="m²" placeholderTextColor={t.color.textMuted} style={input} />
            </View>
            <View style={{ width: 72 }}>
              <T v="tiny" muted>Qty</T>
              <TextInput value={l.quantity} onChangeText={(v) => update(i, { quantity: v })} keyboardType="decimal-pad" style={input} />
            </View>
            <View style={{ flex: 1 }}>
              <T v="tiny" muted>{l.kind === 'labor' ? 'Rate (₦)' : 'Unit cost (₦)'}</T>
              <TextInput value={l.rate} onChangeText={(v) => update(i, { rate: v })} keyboardType="decimal-pad" style={input} />
            </View>
            {l.kind === 'part' ? (
              <View style={{ width: 66 }}>
                <T v="tiny" muted>Markup %</T>
                <TextInput value={l.markupPct} onChangeText={(v) => update(i, { markupPct: v })} keyboardType="decimal-pad" style={input} />
              </View>
            ) : null}
          </Row>
          {milestones.length > 1 ? (
            <Row style={{ flexWrap: 'wrap' }} gap={1}>
              {milestones.map((m, mi) => (
                <Pressable key={mi} onPress={() => update(i, { milestone: mi + 1 })} style={chip(l.milestone === mi + 1)}>
                  <T v="tiny" style={{ color: l.milestone === mi + 1 ? t.color.primaryText : t.color.text }}>{mi + 1}. {m}</T>
                </Pressable>
              ))}
            </Row>
          ) : null}
        </Card>
      ))}
      <Row>
        <View style={{ flex: 1 }}><Button title="+ Labour" kind="secondary" onPress={() => setLines((ls) => [...ls, blank(milestones.length, 'labor')])} /></View>
        <View style={{ flex: 1 }}><Button title="+ Materials" kind="secondary" onPress={() => setLines((ls) => [...ls, blank(milestones.length, 'part')])} /></View>
      </Row>
      <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Notes for the customer (assumptions, exclusions, validity)" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 70, backgroundColor: t.color.surface }]} />

      {preview ? (
        <Card>
          <T v="heading">Summary</T>
          {preview.milestones.map((m: any) => (
            <Row key={m.position} style={{ justifyContent: 'space-between' }}>
              <T muted>{m.position}. {m.title}</T>
              <T style={t.font.money}>{formatMoney(m.totals.customerTotalMinor)}</T>
            </Row>
          ))}
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">Customer pays</T><T v="heading" style={t.font.money}>{formatMoney(preview.totals.customerTotalMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fees (per milestone)</T><T v="small" muted>−{formatMoney(preview.totals.platformCommissionMinor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T>You receive</T><T style={t.font.money}>{formatMoney(preview.totals.technicianNetMinor)}</T></Row>
          {issues.length ? <Banner tone="danger" text={issues.map((x) => x.message).join('\n')} /> : <Tag label="Ready to send" tone="success" />}
        </Card>
      ) : null}

      {draftId ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>I've checked every imported line against my file</T>
          <Switch value={reviewed} onValueChange={setReviewed} />
        </Row>
      ) : null}
      <Button title="Send BOQ to customer" loading={submit.isPending} disabled={!preview || issues.length > 0 || (!!draftId && !reviewed)} onPress={() => submit.mutate()} />
    </Screen>
  );
}
